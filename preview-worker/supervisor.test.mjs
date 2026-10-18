import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { capturePage, messages } from "./worker.mjs";

const execute = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./supervisor-fixture.mjs", import.meta.url),
);
const response = (body, type = "text/html") => ({
  status: 200,
  headers: { "content-type": type },
  body: Buffer.from(body).toString("base64"),
});
const document = {
  type: "start",
  url: "https://public.example/final/index.html",
  document: response(
    '<!doctype html><link rel="stylesheet" href="theme.css"><h1>Native preview</h1>',
  ),
};

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processes() {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,pgid=,stat="]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, group, state] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        group: Number(group),
        state,
      };
    })
    .filter(({ state }) => !state.startsWith("Z"));
}

function kill(pid, signal = "SIGKILL") {
  if (!pid) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function rejectedUpgrade(endpoint, headers = {}) {
  const socket = new WebSocket(endpoint, { headers, handshakeTimeout: 2000 });
  try {
    return await within(
      new Promise((resolve, reject) => {
        socket.once("unexpected-response", (_, response) => {
          response.resume();
          resolve(response.statusCode);
        });
        socket.once("open", () =>
          reject(new Error("Unauthorized websocket accepted")),
        );
        socket.on("error", reject);
      }),
      3000,
      "websocket rejection",
    );
  } finally {
    socket.terminate();
  }
}

async function authenticatedSocket(t, info) {
  const socket = new WebSocket(info.endpoint, {
    headers: { Authorization: `Bearer ${info.token}` },
    handshakeTimeout: 2000,
  });
  t.after(() => socket.terminate());
  await within(once(socket, "open"), 3000, "authenticated websocket");
  // Keep later transport failures from becoming uncaught test-process errors.
  socket.on("error", () => {});
  return socket;
}

async function browserVersion(s, socket, id, milliseconds, label) {
  const controller = new AbortController();
  const closed = () =>
    controller.abort(new Error("Browser control websocket closed"));
  socket.once("close", closed);
  try {
    if (socket.readyState !== WebSocket.OPEN)
      throw new Error("Browser control websocket is not open");
    const reply = once(socket, "message", { signal: controller.signal });
    socket.send(JSON.stringify({ id, method: "Browser.getVersion" }));
    const [frame] = await within(reply, milliseconds, label);
    const version = JSON.parse(frame.toString());
    assert.equal(version.id, id);
    assert.match(version.result.product, /Chrome\//);
  } catch (error) {
    throw new Error(
      `${label}: ${controller.signal.reason?.message ?? error.message}; ${s.diagnostics()}`,
      { cause: error },
    );
  } finally {
    socket.off("close", closed);
    controller.abort();
  }
}

async function browserReady(s, socket) {
  // A listening authenticated bridge is not proof that Chromium has initialized
  // CDP. Charge the first round-trip to the existing launch budget, not the
  // steady-state command deadline; the supervisor's absolute deadline still runs.
  await browserVersion(
    s,
    socket,
    1,
    Math.max(1, 10000 - (performance.now() - s.started)),
    "Chromium CDP readiness",
  );
}

async function session(
  t,
  mode = "capture",
  lifetimeMs = 12000,
  longRoot = false,
) {
  const temporary = mkdtempSync(join(tmpdir(), "clep-supervisor-test-"));
  const jobs = longRoot
    ? join(temporary, "managed-preview-worker-".repeat(8), "jobs")
    : join(temporary, "jobs");
  let inputFd;
  if (mode === "parent") {
    // A separately held writer survives the host's SIGKILL, proving that ppid
    // detection works without EOF (Node normally closes child.stdin on exit).
    const fifo = join(temporary, "input");
    await execute("mkfifo", [fifo]);
    inputFd = openSync(fifo, constants.O_RDWR);
  }
  const started = performance.now();
  const child = spawn(process.execPath, [fixture, mode, jobs], {
    env: { ...process.env, CLEP_PREVIEW_TIMEOUT_MS: String(lifetimeMs) },
    stdio: [inputFd ?? "pipe", "pipe", "pipe", "ipc"],
  });
  child.stdin?.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let browser;
  const ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.type === "browser") {
        browser = message;
        resolve(message);
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!browser)
        reject(new Error(`No browser: exit=${code}/${signal}; ${stderr}`));
    });
  });
  const exit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  t.after(async () => {
    // Failure cleanup is separate from assertions: a broken supervisor must not
    // leave the test suite's real browser or blocked worker running.
    if (inputFd !== undefined) closeSync(inputFd);
    child.stdin?.destroy();
    kill(browser?.supervisorPid, "SIGTERM");
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    try {
      await within(exit, 3000, "fixture teardown");
    } finally {
      kill(browser?.browserPid ? -browser.browserPid : undefined);
      kill(browser?.supervisorPid);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (browser?.temporaryDirectory) {
        rmSync(browser.temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 2,
        });
      }
      rmSync(temporary, { recursive: true, force: true, maxRetries: 2 });
    }
  });
  const send = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    if (inputFd !== undefined) writeSync(inputFd, line);
    else child.stdin.write(line);
  };
  send(document);
  const info = await within(ready, 10000, "real browser launch");
  return {
    child,
    exit,
    info,
    jobs,
    send,
    started,
    lines: messages(child.stdout)[Symbol.asyncIterator](),
    diagnostics: () => stderr,
  };
}

async function next(s) {
  const item = await within(s.lines.next(), 10000, "worker protocol message");
  assert.equal(item.done, false, s.diagnostics());
  return item.value;
}

async function faultReady(s) {
  assert.deepEqual(await next(s), {
    type: "request",
    id: 1,
    method: "GET",
    url: "https://public.example/worker-ready",
  });
  s.send({ type: "response", id: 1, ...response("ok", "text/plain") });
}

async function assertClean(s) {
  const deadline = performance.now() + 2500;
  let remaining;
  do {
    remaining = (await processes()).filter(
      ({ pid, group }) =>
        pid === s.info.supervisorPid || group === s.info.browserPid,
    );
    if (
      !remaining.length &&
      !existsSync(s.info.jobDirectory) &&
      !existsSync(s.info.temporaryDirectory)
    )
      break;
    await delay(25);
  } while (performance.now() < deadline);
  assert.deepEqual(
    remaining,
    [],
    "supervisor or detached Chromium group survived",
  );
  assert.equal(
    existsSync(s.info.jobDirectory),
    false,
    "job directory survived",
  );
  assert.equal(
    existsSync(s.info.temporaryDirectory),
    false,
    "browser temporary directory survived",
  );
  assert.deepEqual(readdirSync(s.jobs), [], "profile/artifact files survived");
}

describe("native preview process lifecycle", {
  skip: !["darwin", "linux"].includes(process.platform),
  concurrency: false,
}, () => {
  test("browser control rejects HTTP discovery and unauthorized WebSockets", async (t) => {
    const s = await session(t, "launch-hang");
    const base = s.info.endpoint.replace(/^ws:/, "http:");
    for (const path of ["/", "/json", "/json/version", "/json/list", "/cdp"]) {
      const response = await fetch(new URL(path, base));
      assert.equal(
        response.status,
        401,
        `Unexpected discovery response for ${path}`,
      );
      const body = await response.text();
      assert.ok(!body.includes(s.info.token));
      assert.ok(!body.includes(s.info.endpoint));
    }
    const headers = { Authorization: `Bearer ${s.info.token}` };
    const discovery = await fetch(new URL("/json", base), { headers });
    assert.equal(discovery.status, 404);
    assert.equal(await discovery.text(), "");
    assert.equal(await rejectedUpgrade(s.info.endpoint), 401);
    assert.equal(
      await rejectedUpgrade(s.info.endpoint, {
        Authorization: "Bearer incorrect",
      }),
      401,
    );
    assert.equal(
      await rejectedUpgrade(s.info.endpoint, {
        ...headers,
        Origin: "https://attacker.example",
      }),
      401,
    );
    assert.equal(
      await rejectedUpgrade(new URL("/json", s.info.endpoint).href, headers),
      404,
    );

    const socket = await authenticatedSocket(t, s.info);
    await browserReady(s, socket);
    await browserVersion(s, socket, 2, 3000, "authorized browser command");
    assert.equal(await rejectedUpgrade(s.info.endpoint, headers), 409);
    socket.terminate();
    s.child.stdin.end();
    await within(s.exit, 2500, "authenticated bridge cleanup");
    await assertClean(s);
  });

  test("authenticated CDP readiness tolerates slow browser startup within the launch deadline", async (t) => {
    const s = await session(t, "launch-delayed");
    const socket = await authenticatedSocket(t, s.info);
    await browserReady(s, socket);
    await browserVersion(s, socket, 2, 3000, "command after delayed startup");
    assert.equal(
      await rejectedUpgrade(s.info.endpoint, {
        Authorization: `Bearer ${s.info.token}`,
      }),
      409,
    );
    socket.terminate();
    s.child.stdin.end();
    await within(s.exit, 2500, "delayed startup cleanup");
    await assertClean(s);
  });

  test("browser exit rejects pending CDP readiness without waiting for its deadline", async (t) => {
    const s = await session(t, "launch-delayed");
    const socket = await authenticatedSocket(t, s.info);
    const ready = browserReady(s, socket);
    kill(-s.info.browserPid);
    await within(
      assert.rejects(ready, /websocket closed|ECONNRESET/),
      2500,
      "browser exit during readiness",
    );
    await within(s.exit, 2500, "failed startup cleanup");
    await assertClean(s);
  });

  test("oversized authenticated frames close the browser and clean the job", async (t) => {
    const s = await session(t, "launch-hang");
    const socket = await authenticatedSocket(t, s.info);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.send("x".repeat(8 * 1024 * 1024 + 1));
    await within(closed, 3000, "oversized frame rejection");
    assert.equal(
      (await within(s.exit, 3000, "oversized frame cleanup")).code,
      1,
    );
    await assertClean(s);
  });

  test("supervised capture renders brokered CSS under a long installation path and removes its browser and files", async (t) => {
    const s = await session(t, "capture", 12000, true);
    assert.ok(Buffer.byteLength(s.info.jobDirectory) > 108);
    assert.equal(statSync(s.info.jobDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(s.info.temporaryDirectory).mode & 0o777, 0o700);
    assert.ok(
      (await processes()).some(
        ({ pid, group }) => pid === s.info.browserPid && group === pid,
      ),
      "Chromium must have its own process group",
    );
    const requested = [];
    let result;
    for (;;) {
      const message = await next(s);
      if (message.type !== "request") {
        result = message;
        break;
      }
      requested.push(message.url);
      assert.equal(message.method, "GET");
      s.send({
        type: "response",
        id: message.id,
        ...(message.url.endsWith("theme.css")
          ? response(
              "body { margin: 0; background: rgb(12, 34, 56); }",
              "text/css",
            )
          : { error: true }),
      });
    }
    assert.equal(result.type, "done");
    assert.ok(requested.includes("https://public.example/final/theme.css"));
    const screenshot = Buffer.from(result.screenshot, "base64");
    assert.deepEqual([...screenshot.subarray(0, 3)], [255, 216, 255]);
    assert.deepEqual(await within(s.exit, 3000, "successful cleanup"), {
      code: 0,
      signal: null,
    });
    await assertClean(s);

    // Decode the returned JPEG in a separate real sandboxed browser, checking
    // pixels rather than merely accepting a JPEG-shaped protocol response.
    await capturePage(
      document,
      async () => ({ error: true }),
      async (page) => {
        const image = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/jpeg;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0);
          return {
            width: image.width,
            height: image.height,
            pixel: [...context.getImageData(1100, 700, 1, 1).data],
          };
        }, result.screenshot);
        assert.equal(image.width, 1200);
        assert.equal(image.height, 800);
        for (const [index, expected] of [12, 34, 56, 255].entries()) {
          assert.ok(
            Math.abs(image.pixel[index] - expected) <= 3,
            `JPEG pixel: ${image.pixel}`,
          );
        }
      },
    );
  });

  test("worker crash terminates the browser process group and removes temporary files", async (t) => {
    const s = await session(t, "crash");
    await faultReady(s);
    assert.equal((await within(s.exit, 3000, "worker crash cleanup")).code, 1);
    await assertClean(s);
  });

  test("watchdog survives a blocked capture thread and includes bounded cleanup", async (t) => {
    const s = await session(t, "hang", 6000);
    await faultReady(s);
    assert.equal(
      (await within(s.exit, 8000, "blocked worker deadline")).code,
      1,
    );
    const elapsed = performance.now() - s.started;
    assert.ok(
      elapsed >= 5000,
      `Worker exited before its deadline: ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 8000,
      `Worker exceeded its absolute lifetime: ${elapsed}ms`,
    );
    await assertClean(s);
  });

  test("browser launch failure removes its fresh profile and job files", async (t) => {
    const s = await session(t, "launch-fail");
    assert.equal((await within(s.exit, 2500, "failed launch cleanup")).code, 1);
    await assertClean(s);
  });

  test("EOF force-kills a stopped browser even when graceful close cannot run", async (t) => {
    const s = await session(t, "hang");
    await faultReady(s);
    kill(-s.info.browserPid, "SIGSTOP");
    const stopped = performance.now();
    s.child.stdin.end();
    assert.equal(
      (await within(s.exit, 2500, "stopped browser cleanup")).code,
      1,
    );
    assert.ok(performance.now() - stopped < 2500);
    await assertClean(s);
  });

  test("EOF cleans a real browser whose launch promise has not resolved", async (t) => {
    const s = await session(t, "launch-hang");
    s.child.stdin.end();
    assert.equal(
      (await within(s.exit, 2500, "pending launch EOF cleanup")).code,
      1,
    );
    await assertClean(s);
  });

  test("absolute watchdog cleans a browser before startup finishes", async (t) => {
    const s = await session(t, "launch-hang", 4000);
    assert.equal(
      (await within(s.exit, 6000, "pending launch deadline")).code,
      1,
    );
    const elapsed = performance.now() - s.started;
    assert.ok(
      elapsed >= 3500,
      `Launch exited before its deadline: ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 6000,
      `Launch exceeded its absolute lifetime: ${elapsed}ms`,
    );
    await assertClean(s);
  });

  test("host SIGKILL is detected with stdin still open and capture thread blocked", async (t) => {
    const s = await session(t, "parent");
    await faultReady(s);
    assert.notEqual(s.info.supervisorPid, s.child.pid);
    s.child.kill("SIGKILL");
    assert.equal(
      (await within(s.exit, 1000, "host termination")).signal,
      "SIGKILL",
    );
    // The separately held FIFO writer stays open until t.after, so this cannot
    // pass solely because closing a dead host's pipes happened to deliver EOF.
    await assertClean(s);
  });

  test("broken stdout during capture triggers browser and temporary-file cleanup", async (t) => {
    const s = await session(t);
    const request = await next(s);
    assert.equal(request.type, "request");
    s.child.stdout.destroy();
    s.send({
      type: "response",
      id: request.id,
      ...response("body { color: red; }", "text/css"),
    });
    assert.equal(
      (await within(s.exit, 7000, "broken protocol output")).code,
      1,
    );
    await assertClean(s);
  });

  test("SIGTERM cleans up independently of a blocked worker thread", async (t) => {
    const s = await session(t, "hang");
    await faultReady(s);
    s.child.kill("SIGTERM");
    assert.equal((await within(s.exit, 2500, "signal cleanup")).code, 1);
    await assertClean(s);
  });
});
