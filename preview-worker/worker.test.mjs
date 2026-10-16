import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  allowedUrl,
  browserLaunchOptions,
  capturePage,
  messages,
} from "./worker.mjs";

const response = (body, type = "text/html", status = 200, headers = {}) => ({
  status,
  headers: { "content-type": type, ...headers },
  body: Buffer.from(body).toString("base64"),
});
const start = (body) => ({
  url: "https://public.example/final/index.html#section",
  document: response(body),
});

test("URL policy rejects credentials and non-HTTP schemes", () => {
  assert.equal(allowedUrl("https://example.com/a?b=c#d"), true);
  for (const url of [
    "file:///etc/passwd",
    "data:text/html,hello",
    "https://user:secret@example.com",
    "invalid",
  ]) {
    assert.equal(allowedUrl(url), false);
  }
});

test("IPC accepts split lines but rejects oversized or truncated input", async () => {
  const results = [];
  for await (const message of messages(
    Readable.from(['{"type":', '"error"}\n']),
  ))
    results.push(message);
  assert.deepEqual(results, [{ type: "error" }]);
  await assert.rejects(async () => {
    for await (const message of messages(
      Readable.from([Buffer.alloc(6 * 1024 * 1024 + 1)]),
    ))
      void message;
  });
  await assert.rejects(async () => {
    for await (const message of messages(Readable.from(['{"type":"error"}'])))
      void message;
  });
});

// These fixtures provide response bytes through the same fetchResource seam
// that the capture worker bridges to checked Rust HTTP. Browser cases require
// the pinned Playwright Chromium installation and a working native sandbox.
test("anonymous capture uses final document URL and never forwards request secrets or POSTs", async () => {
  const requests = [];
  const screenshot = await capturePage(
    start(`<!doctype html>
    <title>Preview fixture</title><h1>Actual anonymous screenshot</h1>
    <link rel="stylesheet" href="theme.css">
    <script>
      document.cookie = 'private=value';
      window.finished = Promise.all([
        fetch('resource', {headers: {'Authorization': 'Bearer secret'}}),
        fetch('post', {method: 'POST', body: 'secret'}).catch(() => null)
      ]).then(() => true);
    </script>`),
    async (request) => {
      requests.push(request);
      return request.url.endsWith("theme.css")
        ? response("body { background: rgb(12, 34, 56); }", "text/css")
        : response("ok", "text/plain");
    },
    async (page) => {
      await page.evaluate(() => window.finished);
      assert.equal(
        await page.evaluate(() => document.location.href),
        "https://public.example/final/index.html#section",
      );
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
        "rgb(12, 34, 56)",
      );
    },
  );
  assert.deepEqual([...screenshot.subarray(0, 3)], [255, 216, 255]);
  assert.ok(
    requests.some(
      (request) => request.url === "https://public.example/final/theme.css",
    ),
  );
  assert.ok(
    requests.some(
      (request) => request.url === "https://public.example/final/resource",
    ),
  );
  assert.ok(
    requests.every(
      (request) =>
        request.method === "GET" &&
        Object.keys(request).sort().join(",") === "method,url",
    ),
  );
  assert.ok(requests.every((request) => !request.url.endsWith("/post")));
});

test("redirected CSS loads and resolves relative assets against its final URL", async () => {
  const requested = [];
  await capturePage(
    start(
      '<link rel="stylesheet" href="/old/theme.css"><h1>Redirect semantics</h1>',
    ),
    async (request) => {
      requested.push(request.url);
      if (request.url.endsWith("/old/theme.css")) {
        return response("", "text/plain", 302, {
          location: "https://public.example/middle/theme.css",
        });
      }
      if (request.url.endsWith("/middle/theme.css")) {
        return response("", "text/plain", 307, {
          location: "https://public.example/new/theme.css",
        });
      }
      if (request.url.endsWith("/new/theme.css")) {
        return response(
          'body { background-color: rgb(12, 34, 56); background-image: url("pixel.svg"); }',
          "text/css",
        );
      }
      return response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
        "image/svg+xml",
      );
    },
    async (page) => {
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
        "rgb(12, 34, 56)",
      );
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundImage,
        ),
        'url("https://public.example/new/pixel.svg")',
      );
    },
  );
  assert.ok(requested.includes("https://public.example/old/theme.css"));
  assert.ok(requested.includes("https://public.example/middle/theme.css"));
  assert.ok(requested.includes("https://public.example/new/theme.css"));
  assert.ok(requested.includes("https://public.example/new/pixel.svg"));
  assert.ok(!requested.includes("https://public.example/old/pixel.svg"));
  assert.ok(!requested.includes("https://public.example/middle/pixel.svg"));
});

test("cross-origin redirect cannot launder a response into a same-origin fetch", async () => {
  await capturePage(
    start(`<script>
    window.result = fetch('/redirect').then(r => r.text()).catch(() => 'blocked');
    </script><h1>Origin isolation</h1>`),
    async (request) => {
      if (request.url === "https://public.example/redirect") {
        return response("", "text/plain", 302, {
          location: "https://other.example/secret",
        });
      }
      return response("cross-origin-secret", "text/plain");
    },
    async (page) => {
      assert.equal(await page.evaluate(() => window.result), "blocked");
    },
  );
});

test("redirected fetch retains its final URL and respects an explicit CORS grant", async () => {
  const requested = [];
  await capturePage(
    start(`<script>
    window.result = fetch('/redirect').then(async r => ({url: r.url, body: await r.text()}));
    </script><h1>Allowed redirected fetch</h1>`),
    async (request) => {
      requested.push(request.url);
      if (request.url === "https://public.example/redirect") {
        return response("", "text/plain", 302, {
          location: "https://other.example/final",
        });
      }
      return response("allowed", "text/plain", 200, {
        "access-control-allow-origin": "*",
      });
    },
    async (page) => {
      assert.deepEqual(await page.evaluate(() => window.result), {
        url: "https://other.example/final",
        body: "allowed",
      });
    },
  );
  assert.ok(requested.includes("https://other.example/final"));
});

test("each redirected resource hop consumes the shared request budget", async () => {
  const requested = [];
  const images = Array.from(
    { length: 60 },
    (_, index) => `<img src="/redirect/${index}">`,
  ).join("");
  await capturePage(
    start(`<h1>Bounded redirects</h1>${images}`),
    async (request) => {
      requested.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/redirect/")) {
        return response("", "text/plain", 302, {
          location: url.pathname.replace("/redirect/", "/final/"),
        });
      }
      return response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
        "image/svg+xml",
      );
    },
  );
  // The initial, pre-fetched document consumes one of the 96 browser requests.
  assert.equal(requested.length, 95);
  assert.ok(
    requested.some((url) => new URL(url).pathname.startsWith("/final/")),
  );
});

test("top-level navigations cannot replace the checked document", async () => {
  const requested = [];
  await capturePage(
    start(
      '<h1>Checked page</h1><script>setTimeout(() => location.assign("https://other.example/"), 10)</script>',
    ),
    async (request) => {
      requested.push(request.url);
      return response("<h1>Unrelated page</h1>");
    },
  );
  assert.ok(!requested.includes("https://other.example/"));
});

test("capture closes only its own context when the browser belongs to a supervisor", async (t) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(browserLaunchOptions);
  t.after(() => browser.close());
  const existing = await browser.newContext();
  const page = await existing.newPage();
  await page.setContent("<h1>Unrelated context</h1>");
  await capturePage(
    start("<h1>Borrowed browser</h1>"),
    async () => ({ error: true }),
    undefined,
    browser,
  );
  assert.equal(browser.isConnected(), true);
  assert.deepEqual(browser.contexts(), [existing]);
  assert.equal(await page.locator("h1").textContent(), "Unrelated context");
});

test("cross-site subframes cannot bypass the broker onto the host network", async (t) => {
  const directRequests = [];
  const child =
    '<h1>Subframe</h1><img src="/escaped"><script>fetch("/escaped-fetch").catch(() => {})</script>';
  const server = createServer((request, reply) => {
    directRequests.push(request.url);
    reply.writeHead(200, { "content-type": "text/html" });
    reply.end(
      request.url === "/child" ? child : "unexpected direct network request",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await capturePage(
    {
      url: `http://127.0.0.1:${port}/main`,
      document: response(
        `<h1>Checked page</h1><iframe src="http://localhost:${port}/child"></iframe>`,
      ),
    },
    async (request) =>
      request.url.endsWith("/child") ? response(child) : { error: true },
  );
  assert.deepEqual(
    directRequests,
    [],
    "subframe requests escaped checked HTTP mediation",
  );
});

test("inline frames, popups, and worker targets cannot acquire unchecked networking", async (t) => {
  const directRequests = [];
  const server = createServer((request, reply) => {
    directRequests.push(request.url);
    reply.end("unexpected direct network request");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const target = `http://localhost:${server.address().port}`;
  await capturePage(
    {
      url: `http://127.0.0.1:${server.address().port}/main`,
      document: response(`<h1>Target policy</h1><script>
      const script = URL.createObjectURL(new Blob([${JSON.stringify(`fetch("${target}/worker").catch(() => {})`)}], {type:"text/javascript"}));
      const workers = ["Worker", "SharedWorker"].map((name) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve("no error"), 4000);
        try {
          const worker = new window[name](script);
          worker.onerror = () => { clearTimeout(timer); resolve("blocked"); };
        } catch {
          clearTimeout(timer);
          resolve("blocked");
        }
      }));
      const frame = document.createElement("iframe");
      document.body.append(frame);
      window.finished = Promise.all([...workers, frame.contentWindow.fetch("${target}/inline-frame").catch(() => null)]);
      window.open("${target}/popup");
    </script>`),
    },
    async () => ({ error: true }),
    async (page) => {
      const outcome = await page.evaluate(() => window.finished);
      assert.deepEqual(outcome.slice(0, 2), ["blocked", "blocked"]);
    },
  );
  assert.deepEqual(
    directRequests,
    [],
    "unsupported targets reached the host network",
  );
});
