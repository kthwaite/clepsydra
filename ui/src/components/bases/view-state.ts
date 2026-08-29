import { asciiCaseFold } from "./local-validation";

/** The slice of `Storage` the Base view-state helpers touch. */
export interface ViewStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_VIEW_PREFIX = "clepsydra.bases.lastView.";

/** `window.localStorage`, or nothing when the browser refuses access. */
export function getViewStateStorage(): ViewStateStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function lastViewKey(slug: string): string {
  return `${LAST_VIEW_PREFIX}${slug}`;
}

export function readLastView(
  storage: ViewStateStorage | undefined,
  slug: string,
): string | undefined {
  try {
    return storage?.getItem(lastViewKey(slug)) || undefined;
  } catch {
    return undefined;
  }
}

export function writeLastView(
  storage: ViewStateStorage | undefined,
  slug: string,
  view: string,
): void {
  try {
    storage?.setItem(lastViewKey(slug), view);
  } catch {
    // Memory is a convenience; a full or sealed store must not break the table.
  }
}

export interface ActiveViewResolution {
  /** The saved view's canonical name, or "" until the definition arrives. */
  view: string;
  /** True when `requested` named no saved view and the URL should drop it. */
  scrub: boolean;
}

/** Pick the view to show: the URL's, else the remembered one, else the first. */
export function resolveActiveView(
  views: ReadonlyArray<{ name: string }>,
  requested: string | undefined,
  remembered: string | undefined,
): ActiveViewResolution {
  const first = views[0];
  if (first === undefined) return { view: "", scrub: false };
  const find = (name: string | undefined) =>
    name === undefined
      ? undefined
      : views.find(
          (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(name),
        );
  const fromRequest = find(requested);
  if (fromRequest) return { view: fromRequest.name, scrub: false };
  return {
    view: (find(remembered) ?? first).name,
    scrub: requested !== undefined,
  };
}
