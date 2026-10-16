import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const MAX_LINE_BYTES = 6 * 1024 * 1024;
const MAX_REQUESTS = 96;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

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

export async function capturePage(start, fetchResource, observePage) {
  if (
    !allowedUrl(start.url) ||
    !start.document ||
    start.document.status !== 200
  ) {
    throw new Error("Invalid capture document");
  }
  const browser = await chromium.launch({
    headless: true,
    // The process is unprivileged inside the networkless, capability-free container.
    chromiumSandbox: false,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--disable-extensions",
      "--disable-dev-shm-usage",
    ],
  });
  try {
    const context = await browser.newContext({
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
          !allowedUrl(request.url)
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
        // Never continue a request onto the container's disabled network.
        await session.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: response.status,
          responseHeaders: Object.entries(response.headers).map(
            ([name, value]) => ({ name, value }),
          ),
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
    await browser.close();
  }
}

async function run() {
  const pending = new Map();
  let nextId = 0;
  let started = false;
  let finished = false;
  const send = (message) =>
    new Promise((resolve, reject) => {
      const line = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        reject(new Error("IPC limit exceeded"));
        return;
      }
      process.stdout.write(line, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  const fetchResource = (request) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      if (id > MAX_REQUESTS) {
        resolve({ error: true });
        return;
      }
      pending.set(id, { resolve, reject });
      void send({ type: "request", id, ...request }).catch(reject);
    });
  let capture;
  try {
    for await (const message of messages(process.stdin)) {
      if (!started && message.type === "start") {
        started = true;
        capture = capturePage(message, fetchResource)
          .then((screenshot) =>
            send({ type: "done", screenshot: screenshot.toString("base64") }),
          )
          .catch(() => send({ type: "error" }))
          .finally(() => {
            finished = true;
            process.stdin.destroy();
          });
      } else if (
        started &&
        message.type === "response" &&
        pending.has(message.id)
      ) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      } else {
        throw new Error("Invalid IPC message");
      }
    }
  } catch (error) {
    if (!finished) throw error;
  } finally {
    for (const request of pending.values()) request.resolve({ error: true });
    if (capture) await capture;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
