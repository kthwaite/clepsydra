import { describe, expect, test } from "vitest";
import {
  activeIndexAt,
  computeTriggers,
  jumpTargetFor,
} from "#/components/codex/scrollTriggers";

describe("computeTriggers", () => {
  test("returns empty for no headings", () => {
    expect(computeTriggers([], 2000)).toEqual([]);
  });

  test("uses natural triggers (headingTop - threshold) when all are reachable", () => {
    expect(computeTriggers([200, 800, 1600], 2000)).toEqual([104, 704, 1504]);
  });

  test("clamps the first trigger to 0 when the heading sits above the threshold", () => {
    expect(computeTriggers([40, 800], 2000)).toEqual([0, 704]);
  });

  test("uplifts unreachable tail triggers onto the scrollable range", () => {
    // maxScroll 2000; last natural trigger would be 2500 - 96 = 2404 (404 past the end)
    const triggers = computeTriggers([100, 1000, 2400, 2500], 2000);
    // headings in the first 40% of the trigger range keep their natural position
    expect(triggers[0]).toBe(4);
    expect(triggers[1]).toBe(904);
    // the last trigger lands exactly on maxScroll
    expect(triggers[3]).toBe(2000);
    // intermediate uplifted trigger stays strictly between its neighbours
    expect(triggers[2]).toBeGreaterThan(904);
    expect(triggers[2]).toBeLessThan(2000);
    // and was actually uplifted from its natural position
    expect(triggers[2]).toBeLessThan(2400 - 96);
  });

  test("keeps triggers strictly increasing for headings clustered at the bottom", () => {
    const triggers = computeTriggers([100, 2500, 2520, 2540, 2560], 2000);
    for (let i = 1; i < triggers.length; i++) {
      expect(triggers[i]).toBeGreaterThan(triggers[i - 1]);
    }
    expect(triggers[triggers.length - 1]).toBe(2000);
    for (const t of triggers) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(2000);
    }
  });

  test("applies no uplift when the container cannot scroll", () => {
    expect(computeTriggers([50, 300], 0)).toEqual([0, 204]);
  });
});

describe("activeIndexAt", () => {
  const triggers = [0, 700, 1500];

  test("returns 0 when there are no triggers", () => {
    expect(activeIndexAt(500, [], 2000)).toBe(0);
  });

  test("returns the last index whose trigger has been passed", () => {
    expect(activeIndexAt(0, triggers, 2000)).toBe(0);
    expect(activeIndexAt(699, triggers, 2000)).toBe(0);
    expect(activeIndexAt(700, triggers, 2000)).toBe(1);
    expect(activeIndexAt(1600, triggers, 2000)).toBe(2);
  });

  test("forces the last index at (or within 1px of) the bottom", () => {
    expect(activeIndexAt(1999.2, [0, 700, 1996, 1999.8], 2000)).toBe(3);
  });

  test("does not force the last index when the container cannot scroll", () => {
    expect(activeIndexAt(0, [0, 204], 0)).toBe(0);
  });
});

describe("jumpTargetFor", () => {
  test("targets headingTop - 16 for ordinary headings", () => {
    const headingTops = [200, 800, 1600];
    const triggers = computeTriggers(headingTops, 2000);
    expect(jumpTargetFor(1, headingTops, triggers, 2000)).toBe(784);
  });

  test("clamps into the clicked heading's band when the next heading is close", () => {
    // headings 40px apart: the naive target (184) would put heading 1 inside
    // the threshold band, highlighting the wrong entry
    const headingTops = [200, 240, 1600];
    const triggers = computeTriggers(headingTops, 2000);
    const target = jumpTargetFor(0, headingTops, triggers, 2000);
    expect(activeIndexAt(target, triggers, 2000)).toBe(0);
  });

  test("never exceeds maxScroll", () => {
    const headingTops = [100, 2500, 2520, 2560];
    const triggers = computeTriggers(headingTops, 2000);
    for (let i = 0; i < headingTops.length; i++) {
      expect(jumpTargetFor(i, headingTops, triggers, 2000)).toBeLessThanOrEqual(
        2000,
      );
    }
  });

  test("jumping to any heading makes that heading the active one", () => {
    // bottom-clustered fixture: the original failure mode
    const headingTops = [100, 600, 2450, 2500, 2540, 2560];
    const maxScroll = 2000;
    const triggers = computeTriggers(headingTops, maxScroll);
    for (let i = 0; i < headingTops.length; i++) {
      const target = jumpTargetFor(i, headingTops, triggers, maxScroll);
      expect(activeIndexAt(target, triggers, maxScroll)).toBe(i);
    }
  });
});
