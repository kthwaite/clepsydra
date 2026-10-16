import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_FRAMES = 128;

// Chromium exposes CDP only on inherited pipes, never on a TCP debugging port.
// The only listening socket is this authenticated, single-client bridge. Notify
// the supervisor synchronously after spawn, before any startup await can hang.
export async function launchBrowser({
  jobDirectory,
  env,
  onSpawn,
  executablePath,
}) {
  if (!executablePath) {
    const { chromium } = await import("playwright-core");
    executablePath = chromium.executablePath();
  }
  const profile = join(jobDirectory, "profile");
  mkdirSync(profile, { mode: 0o700 });
  const child = spawn(
    executablePath,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-default-apps",
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--disable-search-engine-choice-screen",
      "--disable-session-crashed-bubble",
      "--enable-automation",
      "--password-store=basic",
      "--use-mock-keychain",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    {
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  // There is deliberately no --no-sandbox, --disable-setuid-sandbox, or fallback.
  const closed = new Promise((resolve) => child.once("close", resolve));
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  onSpawn(child);
  child.stdout.resume();
  child.stderr.resume();
  const input = child.stdio[3];
  const output = child.stdio[4];
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);
  const sockets = new Set();
  let client;
  let claimed = false;
  let stopped = false;
  let killed = false;
  let pending = [];
  let pendingBytes = 0;
  let frameParts = [];
  let frameBytes = 0;

  const authenticated = (request) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    return (
      supplied.length === authorization.length &&
      timingSafeEqual(supplied, authorization)
    );
  };
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    // No discovery endpoint, even for an authenticated caller. In particular,
    // /json and /json/version never disclose a browser websocket or secret.
    response.writeHead(authenticated(request) ? 404 : 401, {
      "Content-Length": "0",
      Connection: "close",
    });
    response.end();
  });
  server.maxConnections = 8;
  server.headersTimeout = 1000;
  server.requestTimeout = 1000;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(1000, () => socket.destroy());
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    maxFragments: 1024,
    maxBufferedChunks: 2048,
    allowSynchronousEvents: false,
  });

  function stopBridge() {
    if (stopped) return;
    stopped = true;
    pending = [];
    frameParts = [];
    client?.terminate();
    for (const socket of sockets) socket.destroy();
    server.close();
    websocketServer.close();
  }

  function kill() {
    if (!killed && child.pid) {
      killed = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    stopBridge();
    return closed;
  }

  function fail() {
    void kill().catch(() => {});
  }

  function forward(frame) {
    if (stopped) return;
    if (!client) {
      if (
        pendingBytes + frame.length > MAX_QUEUE_BYTES ||
        pending.length >= MAX_PENDING_FRAMES
      ) {
        fail();
        return;
      }
      pending.push(frame);
      pendingBytes += frame.length;
      return;
    }
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount + frame.length > MAX_QUEUE_BYTES) {
      fail();
      return;
    }
    client.send(frame, { binary: false }, (error) => {
      if (error) fail();
    });
  }

  output.on("data", (chunk) => {
    let offset = 0;
    while (offset < chunk.length && !stopped) {
      const end = chunk.indexOf(0, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (
        frameBytes + part.length > MAX_FRAME_BYTES ||
        frameParts.length >= 2048
      ) {
        fail();
        return;
      }
      frameParts.push(part);
      frameBytes += part.length;
      if (end < 0) break;
      const frame = Buffer.concat(frameParts, frameBytes);
      frameParts = [];
      frameBytes = 0;
      if (frame.length) forward(frame);
      offset = end + 1;
    }
  });
  input.on("error", fail);
  output.on("error", fail);
  output.on("end", stopBridge);
  child.once("close", stopBridge);
  server.on("error", fail);
  websocketServer.on("error", fail);
  server.on("upgrade", (request, socket, head) => {
    const reject = (status) => {
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
    };
    if (!authenticated(request) || request.headers.origin) {
      reject("401 Unauthorized");
      return;
    }
    if (request.url !== "/cdp") {
      reject("404 Not Found");
      return;
    }
    if (claimed || stopped) {
      reject("409 Conflict");
      return;
    }
    claimed = true;
    socket.setTimeout(0);
    websocketServer.handleUpgrade(request, socket, head, (connection) => {
      client = connection;
      connection.on("error", fail);
      connection.on("message", (data, binary) => {
        if (stopped) return;
        if (
          binary ||
          data.includes(0) ||
          input.writableLength + data.length + 1 > MAX_QUEUE_BYTES
        ) {
          fail();
          return;
        }
        input.write(data);
        input.write("\0");
      });
      for (const frame of pending) forward(frame);
      pending = [];
      pendingBytes = 0;
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      child.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, backlog: 8 }, resolve);
    });
    if (spawnError) throw spawnError;
    if (stopped) throw new Error("Chromium exited during startup");
    return {
      process: () => child,
      endpoint: `ws://127.0.0.1:${server.address().port}/cdp`,
      token,
      close() {
        stopBridge();
        if (
          child.exitCode === null &&
          child.signalCode === null &&
          !input.destroyed
        ) {
          input.write('{"id":2147483647,"method":"Browser.close"}\0');
        }
        return closed;
      },
      kill,
    };
  } catch (error) {
    void kill().catch(() => {});
    throw error;
  }
}
