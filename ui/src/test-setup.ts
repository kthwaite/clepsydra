import "@testing-library/jest-dom/vitest";

// Polyfill CSS.escape for jsdom (used by @react-aria/selection)
if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
} else if (typeof globalThis.CSS.escape !== "function") {
  globalThis.CSS.escape = (s: string) => s;
}
