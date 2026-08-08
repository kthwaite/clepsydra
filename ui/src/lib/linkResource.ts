export const LINK_RESOURCES = [
  "wikipedia",
  "arxiv",
  "biorxiv",
  "doi",
  "pubmed",
  "semantic-scholar",
  "github",
  "gitlab",
  "internet-archive",
  "youtube",
  "vimeo",
  "pdf",
  "audio",
  "video",
  "image",
] as const;

export type LinkResource = (typeof LINK_RESOURCES)[number];

type HostRule = {
  resource: LinkResource;
  domains: readonly string[];
  includeSubdomains: boolean;
};

const HOST_RULES: readonly HostRule[] = [
  {
    resource: "wikipedia",
    domains: [
      "wikipedia.org",
      "wikimedia.org",
      "wikimediafoundation.org",
      "wiktionary.org",
      "wikisource.org",
      "wikibooks.org",
      "wikiquote.org",
      "mediawiki.org",
    ],
    includeSubdomains: true,
  },
  { resource: "arxiv", domains: ["arxiv.org"], includeSubdomains: true },
  {
    resource: "biorxiv",
    domains: ["biorxiv.org", "medrxiv.org"],
    includeSubdomains: true,
  },
  { resource: "doi", domains: ["doi.org"], includeSubdomains: true },
  {
    resource: "pubmed",
    domains: ["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"],
    includeSubdomains: false,
  },
  {
    resource: "semantic-scholar",
    domains: ["semanticscholar.org"],
    includeSubdomains: true,
  },
  {
    resource: "github",
    domains: ["github.com", "githubusercontent.com"],
    includeSubdomains: true,
  },
  { resource: "gitlab", domains: ["gitlab.com"], includeSubdomains: true },
  {
    resource: "internet-archive",
    domains: ["archive.org"],
    includeSubdomains: true,
  },
  {
    resource: "youtube",
    domains: ["youtube.com"],
    includeSubdomains: true,
  },
  {
    resource: "youtube",
    domains: ["youtu.be"],
    includeSubdomains: false,
  },
  { resource: "vimeo", domains: ["vimeo.com"], includeSubdomains: true },
];

const EXTENSION_RULES: readonly [LinkResource, readonly string[]][] = [
  ["pdf", [".pdf"]],
  ["audio", [".mp3", ".flac", ".ogg", ".wav", ".m4a"]],
  ["video", [".mp4", ".webm", ".mkv", ".mov", ".avi"]],
  ["image", [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]],
];

function matchesHost(
  hostname: string,
  domain: string,
  includeSubdomains: boolean,
): boolean {
  return (
    hostname === domain ||
    (includeSubdomains && hostname.endsWith(`.${domain}`))
  );
}

export function classifyLinkResource(href: string): LinkResource | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const hostname = url.hostname.toLowerCase();
  for (const rule of HOST_RULES) {
    if (
      rule.domains.some((domain) =>
        matchesHost(hostname, domain, rule.includeSubdomains),
      )
    ) {
      return rule.resource;
    }
  }

  const pathname = url.pathname.toLowerCase();
  for (const [resource, extensions] of EXTENSION_RULES) {
    if (extensions.some((extension) => pathname.endsWith(extension))) {
      return resource;
    }
  }

  return null;
}
