// Real-process lifecycle fixtures, excluded from installed worker assets.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

if (!isMainThread) {
  const fault = new URL(import.meta.url).searchParams.get("fault");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(workerData.endpoint, {
    headers: { Authorization: `Bearer ${workerData.token}` },
  });
  parentPort.once("message", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<h1>Live browser before worker failure</h1>");
    parentPort.once("message", () => {
      if (fault === "crash") throw new Error("Deliberate capture worker crash");
      // A blocked capture event loop must not block the supervisor's deadline.
      for (;;) {}
    });
    parentPort.postMessage({
      type: "request",
      id: 1,
      method: "GET",
      url: "https://public.example/worker-ready",
    });
  });
} else if (process.argv[2] === "parent") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "hang", process.argv[3]],
    {
      // These pipe handles survive this host's death. The supervisor cannot
      // rely on EOF: the test still owns the writing end of its stdin pipe.
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: process.env,
    },
  );
  child.on("message", (message) => process.send(message));
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const mode = process.argv[2];
  const { supervise } = await import("./supervisor.mjs");
  const { launchBrowser } = await import("./browser-process.mjs");
  await supervise({
    jobsRoot: process.argv[3],
    ...(["hang", "crash"].includes(mode)
      ? {
          workerURL: new URL(
            `data:text/javascript,${encodeURIComponent(
              `await import(${JSON.stringify(new URL(`?fault=${mode}`, import.meta.url).href)})`,
            )}`,
          ),
        }
      : {}),
    launch: async (options) => {
      if (mode === "launch-fail") {
        process.send({
          type: "browser",
          supervisorPid: process.pid,
          browserPid: null,
          jobDirectory: options.jobDirectory,
        });
        return launchBrowser({
          ...options,
          executablePath: join(options.jobDirectory, "missing-chromium"),
        });
      }
      const browser = await launchBrowser(options);
      process.send({
        type: "browser",
        supervisorPid: process.pid,
        browserPid: browser.process().pid,
        jobDirectory: options.jobDirectory,
        endpoint: browser.endpoint,
        token: browser.token,
      });
      if (mode === "launch-hang") await new Promise(() => {});
      return browser;
    },
  });
}
