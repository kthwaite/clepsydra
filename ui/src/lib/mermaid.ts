// Mermaid diagram rendering, themed with the Vessel tokens.
//
// mermaid is ~1 MB minified — several times the editor chunk — so it stays out
// of the static import graph and loads the first time a diagram is actually
// rendered (mirrors the refractor grammar bundle in editor/refractor-lazy.ts).

type Mermaid = typeof import("mermaid")["default"];

let loadPromise: Promise<Mermaid> | null = null;

/** Start (or join) the mermaid load. Idempotent. */
export function loadMermaid(): Promise<Mermaid> {
  loadPromise ??= import("mermaid").then((module) => module.default);
  return loadPromise;
}

/**
 * Vessel tokens the diagram palette is built from, with fallbacks for
 * environments where the stylesheet is absent (jsdom, Storybook docs frames).
 */
const TOKEN_FALLBACKS: Record<string, string> = {
  "--paper": "#0a0a0a",
  "--paper-2": "#111111",
  "--paper-edge": "#161616",
  "--ink": "#e8e6df",
  "--ink-2": "#b8b5a8",
  "--ink-mute": "#918d80",
  "--accent": "#ee7733",
  "--rule": "#2a2825",
  "--hot": "#ff3b1f",
  "--font-mono": '"JetBrains Mono Variable", ui-monospace, monospace',
};

const TOKENS = Object.keys(TOKEN_FALLBACKS);

function isPaperMode(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("paper")
  );
}

function readTokens(): Record<string, string> {
  const styles =
    typeof window === "undefined"
      ? null
      : window.getComputedStyle(document.documentElement);
  const values: Record<string, string> = {};
  for (const token of TOKENS) {
    values[token] =
      styles?.getPropertyValue(token).trim() || TOKEN_FALLBACKS[token];
  }
  return values;
}

/**
 * Maps the Vessel palette onto mermaid's `base` theme. Only the primaries are
 * set: mermaid derives the rest (arrowheads, sequence actors, note fills) from
 * them, so paper mode and the six accent presets follow automatically.
 */
export function vesselThemeVariables(): Record<string, string | boolean> {
  const t = readTokens();
  return {
    // Dark is the base palette; light mode adds `.paper` to <html>.
    darkMode: !isPaperMode(),
    background: t["--paper"],
    fontFamily: t["--font-mono"],
    fontSize: "13px",

    primaryColor: t["--paper-edge"],
    primaryTextColor: t["--ink"],
    primaryBorderColor: t["--accent"],
    secondaryColor: t["--paper-2"],
    secondaryTextColor: t["--ink-2"],
    secondaryBorderColor: t["--rule"],
    tertiaryColor: t["--paper-2"],
    tertiaryTextColor: t["--ink-2"],
    tertiaryBorderColor: t["--rule"],

    lineColor: t["--ink-mute"],
    textColor: t["--ink"],
    mainBkg: t["--paper-edge"],
    nodeBorder: t["--accent"],
    clusterBkg: t["--paper-2"],
    clusterBorder: t["--rule"],
    edgeLabelBackground: t["--paper"],
    titleColor: t["--ink"],
    noteBkgColor: t["--paper-2"],
    noteTextColor: t["--ink-2"],
    noteBorderColor: t["--rule"],
    errorBkgColor: t["--hot"],
    errorTextColor: t["--paper"],
  };
}

// Theme changes arrive as attribute writes on <html> (see lib/theme.ts:
// `.paper` for light mode, `data-accent` for the accent presets), so a single
// MutationObserver is enough to know when rendered diagrams went stale.
const THEME_ATTRIBUTES = ["class", "data-accent"];

let signature: string | null = null;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

/** Identity of the current palette; changes whenever a diagram must re-render. */
export function themeSignature(): string {
  signature ??= Object.values(vesselThemeVariables()).join("|");
  return signature;
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined") {
    // The palette may have moved while nothing was subscribed.
    signature = null;
    observer = new MutationObserver(() => {
      signature = null;
      for (const notify of [...listeners]) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTES,
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

export type MermaidRenderResult =
  | { ok: true; svg: string }
  | { ok: false; message: string };

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Mermaid could not render this diagram.";
}

let appliedSignature: string | null = null;
let renderCount = 0;

/**
 * Renders mermaid source to an SVG string under the palette identified by
 * `theme` (see `themeSignature`). Never throws: a parse failure comes back as
 * `{ ok: false }` so the caller can fall back to the authored source — the same
 * contract as `renderMathToHtml`.
 */
export async function renderMermaid(
  code: string,
  theme: string,
): Promise<MermaidRenderResult> {
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { ok: false, message: "Could not load the diagram renderer." };
  }

  if (appliedSignature !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      // Sanitizes diagram text and refuses click/script directives from the
      // source — the only boundary where authored markdown becomes markup.
      securityLevel: "strict",
      theme: "base",
      themeVariables: vesselThemeVariables(),
    });
    appliedSignature = theme;
  }

  renderCount += 1;
  const id = `mermaid-render-${renderCount}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return { ok: true, svg };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  } finally {
    // mermaid leaves its measurement nodes attached when a parse fails; drop
    // them so failed renders don't accumulate in the document.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
