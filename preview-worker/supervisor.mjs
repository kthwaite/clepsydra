import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { launchBrowser } from "./browser-process.mjs";
import { messages } from "./worker.mjs";

const MAX_LINE_BYTES = 6 * 1024 * 1024;
const MAX_LIFETIME_MS = 40000;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_LIMIT_MS = 1500;
const FINAL_CLEANUP_MS = 500;

function lifetime() {
  const value = process.env.CLEP_PREVIEW_TIMEOUT_MS;
  if (!value || !/^\d+$/.test(value)) return MAX_LIFETIME_MS;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? Math.min(milliseconds, MAX_LIFETIME_MS)
    : MAX_LIFETIME_MS;
}

function browserEnvironment(jobDirectory, temporaryDirectory) {
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: jobDirectory,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    XDG_CACHE_HOME: join(jobDirectory, "cache"),
    XDG_CONFIG_HOME: join(jobDirectory, "config"),
    XDG_DATA_HOME: join(jobDirectory, "data"),
  };
}

// These dependency seams let lifecycle tests use real browsers with a crashing
// or blocked worker, including a launch that never finishes initialization.
// The installed entry point accepts neither module paths nor launch overrides.
export async function supervise({
  workerURL = new URL("./worker.mjs", import.meta.url),
  jobsRoot = fileURLToPath(new URL("./jobs", import.meta.url)),
  launch = launchBrowser,
} = {}) {
  const parentPid = process.ppid;
  const lifetimeMs = lifetime();
  let jobDirectory;
  let temporaryDirectory;
  let browser;
  let browserPid;
  let worker;
  let launching;
  let stopping = false;
  let terminal = false;
  let groupKilled = false;
  let termination;

  function killBrowserGroup() {
    if (!browserPid || groupKilled) return;
    groupKilled = true;
    try {
      // Chromium is detached: killing Node's process group is not enough.
      process.kill(-browserPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") process.exitCode = 1;
    }
  }

  function removeJobSync() {
    for (const directory of [jobDirectory, temporaryDirectory]) {
      if (!directory) continue;
      try {
        rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        process.stderr.write("Could not remove preview job directory.\n");
        process.exitCode = 1;
      }
    }
  }

  function exitNow(code) {
    killBrowserGroup();
    // The PID is registered immediately after spawn, before startup awaits.
    process.exit(code);
  }

  // Both clocks live on the supervisor's event loop, never the capture thread.
  // The absolute limit includes startup, graceful close, force-kill and cleanup.
  const hardDeadline = setTimeout(() => exitNow(1), lifetimeMs);
  const watchdog = setTimeout(
    () => shutdown(1, true),
    Math.max(0, lifetimeMs - FINAL_CLEANUP_MS),
  );
  const parentCheck = setInterval(() => {
    if (process.ppid !== parentPid) shutdown(1);
  }, 100);
  process.on("exit", killBrowserGroup);
  process.on("exit", removeJobSync);

  function send(message) {
    return new Promise((resolve, reject) => {
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        reject(new Error("IPC limit exceeded"));
        return;
      }
      process.stdout.write(line, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  function forceStop() {
    killBrowserGroup();
    if (browser) void browser.kill().catch(() => {});
    if (worker && !termination) termination = worker.terminate();
  }

  function shutdown(code, force = false) {
    if (stopping) {
      if (force) forceStop();
      return;
    }
    stopping = true;
    clearTimeout(watchdog);
    clearInterval(parentCheck);
    process.stdin.destroy();
    if (!terminal) {
      terminal = true;
      void send({ type: "error" }).catch(() => {});
    }
    // Never wait on a pipe, a browser close, or a worker termination indefinitely.
    const shutdownDeadline = setTimeout(() => exitNow(code), SHUTDOWN_LIMIT_MS);
    const forceTimer = setTimeout(forceStop, force ? 0 : SHUTDOWN_GRACE_MS);
    if (force) forceStop();
    if (worker && !termination) termination = worker.terminate();
    void (async () => {
      await launching;
      await Promise.all([
        browser?.close().catch(() => {}),
        termination?.catch(() => {}),
      ]);
      // Also reap group members if the browser leader exited before its children.
      forceStop();
      if (jobDirectory)
        await rm(jobDirectory, { recursive: true, force: true });
      if (temporaryDirectory)
        await rm(temporaryDirectory, { recursive: true, force: true });
      clearTimeout(forceTimer);
      clearTimeout(shutdownDeadline);
      clearTimeout(hardDeadline);
      exitNow(code);
    })().catch(() => exitNow(1));
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => shutdown(1));
  }
  process.on("uncaughtException", () => shutdown(1));
  process.on("unhandledRejection", () => shutdown(1));
  process.stdin.on("end", () => shutdown(1));
  process.stdin.on("close", () => shutdown(1));
  process.stdin.on("error", () => shutdown(1));
  process.stdout.on("error", () => shutdown(1));
  process.stdout.on("close", () => shutdown(1));

  async function start(message) {
    const env = browserEnvironment(jobDirectory, temporaryDirectory);
    browser = await launch({
      jobDirectory,
      env,
      onSpawn(child) {
        browserPid = child.pid;
        child.once("close", () => {
          if (!terminal) shutdown(1);
        });
        if (stopping) killBrowserGroup();
      },
    });
    if (stopping) {
      forceStop();
      return;
    }
    const workerEnv = { ...env };
    if (process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
      workerEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    worker = new Worker(workerURL, {
      workerData: { endpoint: browser.endpoint, token: browser.token },
      env: workerEnv,
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    // Worker console output must never enter the JSON-lines protocol or block it.
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on("error", () => shutdown(1));
    worker.on("exit", () => {
      if (!terminal) shutdown(1);
    });
    worker.on("message", (response) => {
      if (stopping || terminal) return;
      if (!["request", "done", "error"].includes(response?.type)) {
        shutdown(1);
        return;
      }
      terminal = response.type !== "request";
      void send(response).then(
        () => {
          if (response.type !== "request")
            shutdown(response.type === "done" ? 0 : 1);
        },
        () => shutdown(1),
      );
    });
    worker.postMessage(message);
  }

  try {
    if (!["darwin", "linux"].includes(process.platform)) {
      throw new Error("Native previews require macOS or Linux");
    }
    mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
    jobDirectory = mkdtempSync(join(jobsRoot, "job-"));
    // Chromium creates Unix-domain sockets beneath TMPDIR. A managed generation
    // (or macOS's default temp directory) can exceed the socket pathname limit.
    temporaryDirectory = mkdtempSync("/tmp/clep-preview-");
    for await (const message of messages(process.stdin)) {
      if (stopping) break;
      if (!launching && message?.type === "start") {
        // Do not await here: EOF must be observed even if launch never resolves.
        launching = start(message);
        void launching.catch(() => shutdown(1));
      } else if (worker && message?.type === "response") {
        worker.postMessage(message);
      } else {
        throw new Error("Invalid IPC message");
      }
    }
    shutdown(1);
  } catch {
    shutdown(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void supervise();
}
