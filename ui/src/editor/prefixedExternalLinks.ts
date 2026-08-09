export type PrefixedLinkProvider = "wiki" | "arxiv" | "youtube";

export type ExpandedPrefixedLink = {
  provider: PrefixedLinkProvider;
  url: string;
  label: string;
};

type ProviderRule = (
  rawValue: string,
) => Omit<ExpandedPrefixedLink, "provider"> | null;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function expandWiki(rawValue: string) {
  const label = rawValue.trim().replace(/\s+/g, " ");
  if (!label || CONTROL_CHARACTER.test(label) || label.includes('"')) return null;
  const slug = encodeURIComponent(label.replaceAll(" ", "_"));
  return { url: `https://en.wikipedia.org/wiki/${slug}`, label };
}

const MODERN_ARXIV = /^(\d{4}\.\d{4,5})(?:v([1-9]\d*))?$/i;
const LEGACY_ARXIV = /^([a-z0-9.-]+\/\d{7})(?:v([1-9]\d*))?$/i;

function expandArxiv(rawValue: string) {
  const value = rawValue.trim();
  if (CONTROL_CHARACTER.test(value)) return null;
  const match = MODERN_ARXIV.exec(value) ?? LEGACY_ARXIV.exec(value);
  if (!match) return null;
  const normalized = `${match[1].toLowerCase()}${match[2] ? `v${match[2]}` : ""}`;
  return {
    url: `https://arxiv.org/abs/${normalized}`,
    label: `arXiv: ${normalized}`,
  };
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") candidate = url.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "embed") {
      candidate = parts[1] ?? null;
    }
  }
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

function expandYoutube(rawValue: string) {
  const value = rawValue.trim();
  if (CONTROL_CHARACTER.test(value)) return null;
  const id = YOUTUBE_ID.test(value) ? value : youtubeIdFromUrl(value);
  if (!id) return null;
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    label: `YouTube: ${id}`,
  };
}

const RULES: Record<PrefixedLinkProvider, ProviderRule> = {
  wiki: expandWiki,
  arxiv: expandArxiv,
  youtube: expandYoutube,
};

export function expandPrefixedLink(
  prefix: string,
  rawValue: string,
): ExpandedPrefixedLink | null {
  const provider = prefix.toLowerCase() as PrefixedLinkProvider;
  if (!Object.hasOwn(RULES, provider)) return null;
  const expanded = RULES[provider](rawValue);
  return expanded ? { provider, ...expanded } : null;
}
