import "@testing-library/jest-dom/vitest";

// Polyfill CSS.escape for jsdom (used by @react-aria/selection)
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
} else if (typeof globalThis.CSS.escape !== "function") {
  globalThis.CSS.escape = (s: string) => s;
}

// Node 26 exposes a `localStorage` global that jsdom does not replace and that
// has no usable Storage methods, so any module persisting to it (zustand
// `persist` stores bind at import) throws. Install an in-memory Storage when
// the ambient one is unusable; tests that stub storage themselves still win.
import { installMemoryStorage } from "#/test/memoryStorage";

if (
  typeof globalThis.localStorage === "undefined" ||
  typeof (globalThis.localStorage as Storage | undefined)?.setItem !==
    "function"
) {
  installMemoryStorage();
}
