import { describe, expect, it } from "vitest";
import type { BaseFilter, SortKey } from "#/api/bases";
import {
  EMBED_DEFAULT_LIMIT,
  type BaseEmbedConfig,
  baseViewEvaluationBody,
  capabilityIdentity,
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

    expect(predicateIdentity(changedFilter)).not.toBe(predicateIdentity(initial));
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

  it("defaults an absent limit to 50 in both identity and request body", () => {
    expect(EMBED_DEFAULT_LIMIT).toBe(50);
    expect(normalizeEmbedConfiguration(config()).limit).toBe(50);
    expect(queryIdentity(config())).toBe(queryIdentity(config({ limit: 50 })));
    expect(baseViewEvaluationBody(config())).toMatchObject({ limit: 50 });
  });

  it("omits inherited sort from the payload but sends explicit empty and non-empty sorts", () => {
    const inherited = baseViewEvaluationBody(config({ sort: undefined }));
    const empty = baseViewEvaluationBody(config({ sort: [] }));
    const explicit = baseViewEvaluationBody(
      config({ sort: [{ field: "rating", dir: "desc" }] }),
    );

    expect(Object.hasOwn(inherited, "sort")).toBe(false);
    expect(empty.sort).toEqual([]);
    expect(explicit.sort).toEqual([{ field: "rating", dir: "desc" }]);
  });
});
