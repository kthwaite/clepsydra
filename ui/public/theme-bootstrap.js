// Pre-paint: apply stored operator prefs before React mounts. Dark is the
// base palette (no class), so only deviations need attributes. Keep in sync
// with src/lib/theme.ts. This stays external so production can use a strict
// `script-src 'self'` Content Security Policy.
(function () {
  try {
    var ls = window.localStorage;
    var mode = ls.getItem("clepsydra.theme") || "dark";
    var resolved =
      mode === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : mode;
    var root = document.documentElement;
    if (resolved === "light") root.classList.add("paper");
    root.style.colorScheme = resolved;
    var accent = ls.getItem("clepsydra.accent");
    if (accent && accent !== "barbican") root.setAttribute("data-accent", accent);
    var density = ls.getItem("clepsydra.density");
    if (density && density !== "default") root.setAttribute("data-density", density);
    if (ls.getItem("clepsydra.diegetic") === "off")
      root.setAttribute("data-diegetic", "off");
  } catch (e) {}
})();
