// Pre-paint: apply stored operator prefs before React mounts. Charcoal is the
// base palette (no class); bone adds `.paper` and is the default. Keep in sync
// with src/lib/theme.ts (src/__tests__/themeBootstrap.test.ts enforces it).
// This stays external so production can use a strict `script-src 'self'` CSP.
(function () {
  try {
    var ls = window.localStorage;
    var mode = ls.getItem("clepsydra.theme") || "light";
    var resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : mode;
    var root = document.documentElement;
    if (resolved === "light") root.classList.add("paper");
    else root.classList.remove("paper");
    root.style.colorScheme = resolved;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "light" ? "#F4EFE4" : "#151412");
    var density = ls.getItem("clepsydra.density");
    if (density && density !== "default") root.setAttribute("data-density", density);
    if (ls.getItem("clepsydra.diegetic") === "off")
      root.setAttribute("data-diegetic", "off");
  } catch (e) {}
})();
