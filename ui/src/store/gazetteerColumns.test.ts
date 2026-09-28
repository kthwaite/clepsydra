import { beforeEach, describe, expect, it } from "vitest";
import { useGazetteerColumnsStore } from "./gazetteerColumns";

const KEY = "clepsydra.gazetteer.columns";

beforeEach(() => {
  localStorage.clear();
  useGazetteerColumnsStore.setState({ columnWidths: {}, columnOrder: [] });
});

describe("gazetteer columns store", () => {
  it("migrates a v1 payload to v2, keeping the stored widths", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { columnWidths: { tags: 226, code: 88 } },
        version: 1,
      }),
    );
    await useGazetteerColumnsStore.persist.rehydrate();
    const state = useGazetteerColumnsStore.getState();
    expect(state.columnWidths).toEqual({ tags: 226, code: 88 });
    expect(state.columnOrder).toEqual([]);
  });

  it("persists the column order at version 2", () => {
    useGazetteerColumnsStore
      .getState()
      .setColumnOrder(["no", "code", "tags", "title"]);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored.version).toBe(2);
    expect(stored.state.columnOrder).toEqual(["no", "code", "tags", "title"]);
  });

  it("resets widths and order together", () => {
    const store = useGazetteerColumnsStore.getState();
    store.setColumnWidth("tags", 300);
    store.setColumnOrder(["tags", "title"]);
    useGazetteerColumnsStore.getState().resetColumns();
    const state = useGazetteerColumnsStore.getState();
    expect(state.columnWidths).toEqual({});
    expect(state.columnOrder).toEqual([]);
  });
});
