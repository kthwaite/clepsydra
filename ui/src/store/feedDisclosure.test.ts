import { describe, expect, it, vi } from "vitest";
import {
  emptyFeedDisclosurePreferences,
  feedDisclosureStorageKey,
  normalizeFeedGroupIdentity,
  readFeedDisclosurePreferences,
  reconcileFeedDisclosurePreferences,
  writeFeedDisclosurePreferences,
  type FeedDisclosurePreferences,
  type FeedDisclosureStorage,
} from "#/store/feedDisclosure";

function memoryStorage(initial: Record<string, string> = {}): FeedDisclosureStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function expectEmpty(preferences: FeedDisclosurePreferences) {
  expect([...preferences.groups]).toEqual([]);
  expect([...preferences.feeds]).toEqual([]);
}

describe("feed disclosure preferences", () => {
  it.each([
    ["a missing value", undefined],
    ["malformed JSON", "{"],
    ["JSON null", "null"],
    ["a scalar", '"collapsed"'],
  ])("reads %s as empty collapsed sets", (_label, stored) => {
    const namespace = "vault-alpha";
    const storage = memoryStorage(
      stored === undefined
        ? {}
        : { [feedDisclosureStorageKey(namespace)]: stored },
    );

    expectEmpty(readFeedDisclosurePreferences(storage, namespace));
  });

  it.each([
    ["an unknown version", { version: 2, groups: [], feeds: [] }],
    ["a non-array group field", { version: 1, groups: {}, feeds: [] }],
    ["a non-array feed field", { version: 1, groups: [], feeds: {} }],
    ["a non-string group", { version: 1, groups: [7], feeds: [] }],
    ["a non-number feed", { version: 1, groups: [], feeds: ["7"] }],
    ["a non-positive feed", { version: 1, groups: [], feeds: [0] }],
    ["a fractional feed", { version: 1, groups: [], feeds: [1.5] }],
    ["a non-finite feed", { version: 1, groups: [], feeds: [null] }],
  ])("rejects %s", (_label, value) => {
    const namespace = "vault-alpha";
    const storage = memoryStorage({
      [feedDisclosureStorageKey(namespace)]: JSON.stringify(value),
    });

    expectEmpty(readFeedDisclosurePreferences(storage, namespace));
  });

  it("writes deterministic, namespace-specific data without domain fields", () => {
    const storage = memoryStorage();
    const preferences = {
      groups: new Set([" research ", "Engineering", "RESEARCH"]),
      feeds: new Set([9, 2, -4, Number.NaN]),
      manifestRevision: "must-not-persist",
      urls: ["https://private.example/feed.xml"],
    } as FeedDisclosurePreferences & Record<string, unknown>;

    writeFeedDisclosurePreferences(storage, "vault-alpha", preferences);

    expect(storage.values.get(feedDisclosureStorageKey("vault-alpha"))).toBe(
      JSON.stringify({
        version: 1,
        groups: ["engineering", "research"],
        feeds: [2, 9],
      }),
    );
    expect(storage.values.has(feedDisclosureStorageKey("vault-beta"))).toBe(
      false,
    );
    expect(
      Object.keys(
        JSON.parse(
          storage.values.get(feedDisclosureStorageKey("vault-alpha")) ?? "{}",
        ),
      ),
    ).toEqual(["version", "groups", "feeds"]);
  });

  it("does not set storage when the committed serialization is unchanged", () => {
    const namespace = "vault-alpha";
    const serialized = JSON.stringify({
      version: 1,
      groups: ["engineering"],
      feeds: [7],
    });
    const storage = memoryStorage({
      [feedDisclosureStorageKey(namespace)]: serialized,
    });

    writeFeedDisclosurePreferences(storage, namespace, {
      groups: new Set(["Engineering"]),
      feeds: new Set([7]),
    });

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.get(feedDisclosureStorageKey(namespace))).toBe(
      serialized,
    );
  });

  it("contains storage getter and setter exceptions", () => {
    const throwingGetter: FeedDisclosureStorage = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: vi.fn(),
    };
    const throwingSetter: FeedDisclosureStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    expect(() =>
      readFeedDisclosurePreferences(throwingGetter, "vault-alpha"),
    ).not.toThrow();
    expectEmpty(readFeedDisclosurePreferences(throwingGetter, "vault-alpha"));
    expect(() =>
      writeFeedDisclosurePreferences(throwingSetter, "vault-alpha", {
        groups: new Set(["Engineering"]),
        feeds: new Set([7]),
      }),
    ).not.toThrow();
  });

  it("normalizes and deduplicates group identities", () => {
    expect(normalizeFeedGroupIdentity("  RÉSUMÉ  ")).toBe("résumé");
    const namespace = "vault-alpha";
    const storage = memoryStorage({
      [feedDisclosureStorageKey(namespace)]: JSON.stringify({
        version: 1,
        groups: [" Engineering ", "engineering", "RESEARCH"],
        feeds: [],
      }),
    });

    const preferences = readFeedDisclosurePreferences(storage, namespace);

    expect([...preferences.groups]).toEqual(["engineering", "research"]);
  });

  it("purely prunes obsolete identities while retaining live groups and feeds", () => {
    const preferences: FeedDisclosurePreferences = {
      groups: new Set(["engineering", "obsolete", "research"]),
      feeds: new Set([2, 7, 99]),
    };

    const reconciled = reconcileFeedDisclosurePreferences(preferences, {
      groups: [
        { name: " Engineering ", feeds: [{ id: 7 }] },
        { name: "Research", feeds: [{ id: 2 }] },
      ],
    });

    expect([...reconciled.groups]).toEqual(["engineering", "research"]);
    expect([...reconciled.feeds]).toEqual([2, 7]);
  });

  it("keeps the same preferences when reconciliation is unchanged", () => {
    const preferences: FeedDisclosurePreferences = {
      groups: new Set(["engineering"]),
      feeds: new Set([7]),
    };

    const reconciled = reconcileFeedDisclosurePreferences(preferences, {
      groups: [{ name: "Engineering", feeds: [{ id: 7 }] }],
    });

    expect(reconciled).toBe(preferences);
  });

  it("does not reconcile without a successful live manifest", () => {
    const preferences: FeedDisclosurePreferences = {
      groups: new Set(["possibly-live"]),
      feeds: new Set([44]),
    };

    const reconciled = reconcileFeedDisclosurePreferences(
      preferences,
      undefined,
    );

    expect(reconciled).toBe(preferences);
    expect([...reconciled.groups]).toEqual(["possibly-live"]);
    expect([...reconciled.feeds]).toEqual([44]);
  });

  it("creates independent empty set instances", () => {
    const first = emptyFeedDisclosurePreferences();
    const second = emptyFeedDisclosurePreferences();

    first.groups.add("engineering");
    first.feeds.add(7);

    expectEmpty(second);
  });
});
