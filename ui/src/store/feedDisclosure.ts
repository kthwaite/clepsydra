export interface FeedDisclosurePreferences {
  groups: Set<string>;
  feeds: Set<number>;
}

export interface FeedDisclosureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FeedDisclosureManifest {
  groups: ReadonlyArray<{
    name: string;
    feeds: ReadonlyArray<{ id: number }>;
  }>;
}

interface StoredFeedDisclosurePreferences {
  version: 1;
  groups: string[];
  feeds: number[];
}

const STORAGE_PREFIX = "clepsydra.feeds.disclosure.";

export function emptyFeedDisclosurePreferences(): FeedDisclosurePreferences {
  return { groups: new Set(), feeds: new Set() };
}

export function feedDisclosureStorageKey(preferenceNamespace: string): string {
  return `${STORAGE_PREFIX}${preferenceNamespace}`;
}

export function normalizeFeedGroupIdentity(group: string): string {
  return group.trim().toLocaleLowerCase("en-US");
}

function isFeedId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function parseStoredPreferences(
  value: unknown,
): FeedDisclosurePreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const candidate = value as Partial<StoredFeedDisclosurePreferences>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.groups) ||
    !Array.isArray(candidate.feeds) ||
    !candidate.groups.every((group) => typeof group === "string") ||
    !candidate.feeds.every(isFeedId)
  ) {
    return undefined;
  }

  return {
    groups: new Set(candidate.groups.map(normalizeFeedGroupIdentity)),
    feeds: new Set(candidate.feeds),
  };
}

export function readFeedDisclosurePreferences(
  storage: FeedDisclosureStorage | null | undefined,
  preferenceNamespace: string,
): FeedDisclosurePreferences {
  try {
    const stored = storage?.getItem(
      feedDisclosureStorageKey(preferenceNamespace),
    );
    if (!stored) return emptyFeedDisclosurePreferences();
    return (
      parseStoredPreferences(JSON.parse(stored)) ??
      emptyFeedDisclosurePreferences()
    );
  } catch {
    return emptyFeedDisclosurePreferences();
  }
}

function serializePreferences(
  preferences: FeedDisclosurePreferences,
): StoredFeedDisclosurePreferences {
  const groups = [...preferences.groups]
    .filter((group): group is string => typeof group === "string")
    .map(normalizeFeedGroupIdentity);
  const feeds = [...preferences.feeds].filter(isFeedId);

  return {
    version: 1,
    groups: [...new Set(groups)].sort(),
    feeds: [...new Set(feeds)].sort((left, right) => left - right),
  };
}

export function writeFeedDisclosurePreferences(
  storage: FeedDisclosureStorage | null | undefined,
  preferenceNamespace: string,
  preferences: FeedDisclosurePreferences,
): void {
  try {
    storage?.setItem(
      feedDisclosureStorageKey(preferenceNamespace),
      JSON.stringify(serializePreferences(preferences)),
    );
  } catch {
    // Persistence is a preference only; unavailable storage must not break feeds.
  }
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function reconcileFeedDisclosurePreferences(
  storage: FeedDisclosureStorage | null | undefined,
  preferenceNamespace: string,
  preferences: FeedDisclosurePreferences,
  manifest: FeedDisclosureManifest | undefined,
): FeedDisclosurePreferences {
  if (!manifest) return preferences;

  const liveGroups = new Set<string>();
  const liveFeeds = new Set<number>();
  for (const group of manifest.groups) {
    liveGroups.add(normalizeFeedGroupIdentity(group.name));
    for (const feed of group.feeds) {
      if (isFeedId(feed.id)) liveFeeds.add(feed.id);
    }
  }

  const groups = new Set(
    [...preferences.groups].filter((group) => liveGroups.has(group)),
  );
  const feeds = new Set(
    [...preferences.feeds].filter((feed) => liveFeeds.has(feed)),
  );
  if (
    setsEqual(groups, preferences.groups) &&
    setsEqual(feeds, preferences.feeds)
  ) {
    return preferences;
  }

  const reconciled = { groups, feeds };
  writeFeedDisclosurePreferences(
    storage,
    preferenceNamespace,
    reconciled,
  );
  return reconciled;
}

export function getFeedDisclosureStorage(): FeedDisclosureStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
