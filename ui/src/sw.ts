/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import {
  API_CACHE_NAME,
  classifyRequest,
  offlineUncachedResponse,
} from "./offline/swPolicy";

declare const self: ServiceWorkerGlobalScope;

// New deploys take over immediately; the page reloads on its own next launch.
self.skipWaiting();
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// App shell: every hashed chunk plus index.html, injected at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations always get the precached shell so deep links work offline,
// except under /api/: a top-level navigation to an API path (e.g. an
// attachment link opened in a new tab) must reach the network, never the
// cached app shell.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  }),
);

const apiStrategy = new NetworkFirst({
  cacheName: API_CACHE_NAME,
  networkTimeoutSeconds: 4,
  plugins: [new CacheableResponsePlugin({ statuses: [200] })],
});

function classOf(url: URL, request: Request) {
  return classifyRequest({
    url,
    method: request.method,
    mode: request.mode,
    origin: self.location.origin,
  });
}

registerRoute(
  ({ url, request }) => classOf(url, request) === "network-only",
  new NetworkOnly(),
);

registerRoute(
  ({ url, request }) => classOf(url, request) === "api",
  async (options) => {
    try {
      return await apiStrategy.handle(options);
    } catch {
      // NetworkFirst throws when neither the network nor the cache answered.
      return offlineUncachedResponse(options.request.url);
    }
  },
);
