import { isMainThread, parentPort, workerData } from "node:worker_threads";

const MAX_LINE_BYTES = 6 * 1024 * 1024;
const MAX_REQUESTS = 96;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

export const browserLaunchOptions = {
  headless: true,
  channel: "chromium",
  chromiumSandbox: true,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--disable-extensions",
    "--disable-dev-shm-usage",
  ],
};

export function allowedUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Do not concatenate unbounded readline input from either side of the IPC seam.
export async function* messages(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    let rest = Buffer.from(chunk);
    while (rest.length) {
      const newline = rest.indexOf(10);
      const part = newline < 0 ? rest : rest.subarray(0, newline);
      if (pending.length + part.length > MAX_LINE_BYTES)
        throw new Error("IPC limit exceeded");
      pending = Buffer.concat([pending, part]);
      if (newline < 0) break;
      const message = JSON.parse(pending.toString("utf8"));
      pending = Buffer.alloc(0);
      rest = rest.subarray(newline + 1);
      yield message;
    }
  }
  if (pending.length) throw new Error("Incomplete IPC message");
}

function withoutFragment(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

// A supplied browser is owned by the supervisor; only this capture's context closes.
export async function capturePage(start, fetchResource, observePage, browser) {
  if (
    !allowedUrl(start.url) ||
    !start.document ||
    start.document.status !== 200
  ) {
    throw new Error("Invalid capture document");
  }
  const ownsBrowser = !browser;
  if (!browser) {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch(browserLaunchOptions);
  }
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
      javaScriptEnabled: true,
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    context.on("page", (popup) => {
      if (popup !== page) void popup.close();
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
    // Playwright applies this guard to every target, including out-of-process
    // frames. The main target still uses CDP below for per-hop mediation.
    await context.route("**/*", async (route) => {
      try {
        if (route.request().frame() !== page.mainFrame()) {
          await route.abort("blockedbyclient");
          return;
        }
      } catch {
        // Requests without a page frame belong to unsupported worker targets.
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const mainFrameId = frameTree.frame.id;
    let documentServed = false;
    let requests = 0;
    session.on("Fetch.authRequired", (event) => {
      void session
        .send("Fetch.continueWithAuth", {
          requestId: event.requestId,
          authChallengeResponse: { response: "CancelAuth" },
        })
        .catch(() => {});
    });
    session.on("Fetch.requestPaused", async (event) => {
      const { requestId, request } = event;
      const abort = () =>
        session.send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
      try {
        // Fetch pauses every redirect hop, unlike Playwright's route handler.
        // Count even rejected requests so redirects cannot bypass the budget.
        if (
          ++requests > MAX_REQUESTS ||
          request.method !== "GET" ||
          !allowedUrl(request.url) ||
          (event.resourceType === "Document" && event.frameId !== mainFrameId)
        ) {
          await abort();
          return;
        }
        let response;
        if (
          event.resourceType === "Document" &&
          event.frameId === mainFrameId
        ) {
          // Navigate at the checked final URL, never render redirected HTML at the old origin.
          if (
            documentServed ||
            withoutFragment(request.url) !== withoutFragment(start.url)
          ) {
            await abort();
            return;
          }
          documentServed = true;
          response = start.document;
        } else {
          // Browser cookies, authorization, referrers and other headers never cross IPC.
          response = await fetchResource({
            url: request.url,
            method: request.method,
          });
        }
        if (!response || response.error) {
          await abort();
          return;
        }
        // Keep each 30x intact: Chromium follows it and enforces origin/CORS
        // semantics, then Fetch pauses the next hop for another checked host GET.
        // Never continue a page request onto the host network.
        const responseHeaders = Object.entries(response.headers).map(
          ([name, value]) => ({ name, value }),
        );
        if (event.resourceType === "Document") {
          // Add, rather than replace, the publisher's policy. Frames, plugins,
          // and worker targets are unsupported and must not acquire networking
          // outside the main page's checked CDP session.
          responseHeaders.push({
            name: "content-security-policy",
            value: "frame-src 'none'; worker-src 'none'; object-src 'none'",
          });
        }
        await session.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: response.status,
          responseHeaders,
          body: response.body,
        });
      } catch {
        await abort().catch(() => {});
      }
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
      handleAuthRequests: true,
    });
    await page.goto(start.url, {
      waitUntil: "domcontentloaded",
      timeout: 16000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 4000 })
      .catch(() => {});
    if (observePage) await observePage(page);
    const screenshot = await page.screenshot({
      type: "jpeg",
      quality: 65,
      timeout: 4000,
    });
    if (screenshot.length > MAX_SCREENSHOT_BYTES)
      throw new Error("Screenshot limit exceeded");
    return screenshot;
  } finally {
    if (ownsBrowser) await browser.close();
    else await context?.close();
  }
}

async function run() {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(workerData.endpoint, {
    headers: { Authorization: `Bearer ${workerData.token}` },
    timeout: 16000,
  });
  const pending = new Map();
  let nextId = 0;
  let started = false;
  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    parentPort.postMessage(message);
    for (const request of pending.values()) request({ error: true });
    pending.clear();
    parentPort.close();
    void browser.close().catch(() => {});
  };
  const fetchResource = (request) =>
    new Promise((resolve) => {
      const id = ++nextId;
      if (id > MAX_REQUESTS || finished) {
        resolve({ error: true });
        return;
      }
      pending.set(id, resolve);
      parentPort.postMessage({ type: "request", id, ...request });
    });
  parentPort.on("message", (message) => {
    if (finished) return;
    if (!started && message.type === "start") {
      started = true;
      void capturePage(message, fetchResource, undefined, browser).then(
        (screenshot) =>
          finish({ type: "done", screenshot: screenshot.toString("base64") }),
        () => finish({ type: "error" }),
      );
    } else if (
      started &&
      message.type === "response" &&
      pending.has(message.id)
    ) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else {
      finish({ type: "error" });
    }
  });
}

if (!isMainThread && parentPort) {
  run().catch(() => {
    parentPort.postMessage({ type: "error" });
    parentPort.close();
  });
}
