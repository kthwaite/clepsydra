import { describe, expect, it } from "vitest";
import type { BaseFilter, SortKey } from "#/api/bases";
import {
  type BaseEmbedConfig,
  baseViewEvaluationBody,
  capabilityIdentity,
  EMBED_WINDOW_ROWS,
  nextWindowSize,
  normalizeEmbedConfiguration,
  predicateIdentity,
  queryIdentity,
} from "#/components/bases/embed-query";

const statusIsReading: BaseFilter = {
  field: "status",
  op: "eq",
  value: "reading",
};
const ratingAtLeastFour: BaseFilter = {
  field: "rating",
  op: "gte",
  value: 4,
};

function config(overrides: Partial<BaseEmbedConfig> = {}): BaseEmbedConfig {
  return {
    base: "books",
    view: "Reading",
    filter: statusIsReading,
    ...overrides,
  };
}

describe("embedded Base configuration identity", () => {
  it("recursively canonicalizes object keys without mutating input", () => {
    const leftFilter = {
      all: [
        { value: { z: 1, nested: { b: 2, a: 1 } }, op: "eq", field: "meta" },
        ratingAtLeastFour,
      ],
    } as BaseFilter;
    const rightFilter = {
      all: [
        { field: "meta", op: "eq", value: { nested: { a: 1, b: 2 }, z: 1 } },
        ratingAtLeastFour,
      ],
    } as BaseFilter;
    const before = structuredClone(leftFilter);

    expect(predicateIdentity(config({ filter: leftFilter }))).toBe(
      predicateIdentity(config({ filter: rightFilter })),
    );
    expect(leftFilter).toEqual(before);
  });

  it("preserves logical-child and value-array order", () => {
    expect(
      predicateIdentity(
        config({ filter: { all: [statusIsReading, ratingAtLeastFour] } }),
      ),
    ).not.toBe(
      predicateIdentity(
        config({ filter: { all: [ratingAtLeastFour, statusIsReading] } }),
      ),
    );
    expect(
      predicateIdentity(
        config({ filter: { field: "tags", op: "eq", value: ["a", "b"] } }),
      ),
    ).not.toBe(
      predicateIdentity(
        config({ filter: { field: "tags", op: "eq", value: ["b", "a"] } }),
      ),
    );
  });

  it("folds only ASCII case in view identity and retains slug identity", () => {
    expect(predicateIdentity(config({ view: "rEADING" }))).toBe(
      predicateIdentity(config({ view: "Reading" })),
    );
    expect(predicateIdentity(config({ view: "Ä" }))).not.toBe(
      predicateIdentity(config({ view: "ä" })),
    );
    expect(predicateIdentity(config({ base: "films" }))).not.toBe(
      predicateIdentity(config()),
    );
  });

  it("changes predicate and capability identities at their exact boundaries", () => {
    const initial = config();
    const changedFilter = config({ filter: ratingAtLeastFour });

    expect(predicateIdentity(changedFilter)).not.toBe(
      predicateIdentity(initial),
    );
    expect(capabilityIdentity(initial, "rev-1")).not.toBe(
      capabilityIdentity(changedFilter, "rev-1"),
    );
    expect(capabilityIdentity(initial, "rev-2")).not.toBe(
      capabilityIdentity(initial, "rev-1"),
    );
    expect(predicateIdentity(config({ sort: [] }))).toBe(
      predicateIdentity(initial),
    );
  });

  it("distinguishes inherited, empty, and ordered explicit sorts", () => {
    const first: SortKey = { field: "rating", dir: "desc" };
    const second: SortKey = { field: "title", dir: "asc" };

    expect(queryIdentity(config({ sort: undefined }))).not.toBe(
      queryIdentity(config({ sort: [] })),
    );
    expect(queryIdentity(config({ sort: [] }))).not.toBe(
      queryIdentity(config({ sort: [first] })),
    );
    expect(queryIdentity(config({ sort: [first, second] }))).not.toBe(
      queryIdentity(config({ sort: [second, first] })),
    );
  });

  it("keeps an absent author limit distinct from a limit of one window", () => {
    expect(normalizeEmbedConfiguration(config()).limit).toBeUndefined();
    // Absent means "scroll to the true total"; 50 means "stop at 50".
    expect(queryIdentity(config())).not.toBe(
      queryIdentity(config({ limit: 50 })),
    );
  });

  it("sends the window it is asked for, not the author's ceiling", () => {
    expect(
      baseViewEvaluationBody(config({ limit: 400 }), {
        limit: 50,
        offset: 100,
      }),
    ).toMatchObject({ limit: 50, offset: 100 });
  });

  it("sizes the next window against the author's ceiling", () => {
    expect(nextWindowSize(undefined, 250)).toBe(EMBED_WINDOW_ROWS);
    expect(nextWindowSize(120, 50)).toBe(EMBED_WINDOW_ROWS);
    expect(nextWindowSize(53, 50)).toBe(3);
    expect(nextWindowSize(50, 50)).toBe(0);
    expect(nextWindowSize(10, 40)).toBe(0);
  });

  it("omits inherited sort from the payload but sends explicit empty and non-empty sorts", () => {
    const firstWindow = { limit: 50, offset: 0 };
    const inherited = baseViewEvaluationBody(
      config({ sort: undefined }),
      firstWindow,
    );
    const empty = baseViewEvaluationBody(config({ sort: [] }), firstWindow);
    const explicit = baseViewEvaluationBody(
      config({ sort: [{ field: "rating", dir: "desc" }] }),
      firstWindow,
    );

    expect(Object.hasOwn(inherited, "sort")).toBe(false);
    expect(empty.sort).toEqual([]);
    expect(explicit.sort).toEqual([{ field: "rating", dir: "desc" }]);
  });

  it("carries a group override into the body and the query identity, not the predicate", () => {
    const base = { base: "reading", view: "Continues" };
    const grouped = {
      ...base,
      groupBy: { kind: "by", field: "status" } as const,
    };
    const flat = { ...base, groupBy: { kind: "flat" } as const };
    expect(baseViewEvaluationBody(base, { limit: 50, offset: 0 })).toEqual({
      limit: 50,
      offset: 0,
    });
    expect(baseViewEvaluationBody(grouped, { limit: 50, offset: 0 })).toEqual({
      group_by: "status",
      limit: 50,
      offset: 0,
    });
    expect(baseViewEvaluationBody(flat, { limit: 50, offset: 0 })).toEqual({
      group_by: "",
      limit: 50,
      offset: 0,
    });
    expect(predicateIdentity(grouped)).toBe(predicateIdentity(base));
    expect(queryIdentity(grouped)).not.toBe(queryIdentity(base));
    expect(queryIdentity(flat)).not.toBe(queryIdentity(grouped));
  });
});
