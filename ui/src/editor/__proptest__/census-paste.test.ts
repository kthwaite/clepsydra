/**
 * Paste and conversion census: samples histories and groups violations by
 * signature, keeping the smallest witness for each. Asserts nothing. Env:
 * CENSUS_RUNS, CENSUS_SEED, CENSUS_OUT, CENSUS_MASK (signature substrings to
 * ignore), CENSUS_KINDS (op kinds to enable). SHRINK_SIGS + SHRINK_OUT shrink
 * one witness per signature prefix.
 */
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { it } from "vitest";
import type { Violation } from "./census";
import { newCoverage, replayPaste } from "./census-paste";
import { arbDoc, buildDoc } from "./harness";
import {
  arbPasteOps,
  PASTE_OP_KINDS,
  type PasteOp,
  type PasteOpKind,
} from "./harness-paste";

const RUNS = Number(process.env.CENSUS_RUNS ?? 300);
const SEED = Number(process.env.CENSUS_SEED ?? 20261104);
const MASK = (process.env.CENSUS_MASK ?? "").split(",").filter(Boolean);
const KINDS = (process.env.CENSUS_KINDS ?? PASTE_OP_KINDS.join(","))
  .split(",")
  .filter(Boolean) as PasteOpKind[];

const caseArb = fc
  .tuple(
    fc.record({
      voids: fc.boolean(),
      extras: fc.boolean(),
      tasks: fc.boolean(),
      empties: fc.boolean(),
    }),
    fc.subarray([...KINDS], { minLength: 1 }),
  )
  .chain(([p, kinds]) =>
    fc.record({
      spec: arbDoc(p),
      ops: arbPasteOps(kinds, 6),
    }),
  );

interface Row {
  sig: string;
  count: number;
  witness: {
    spec: unknown;
    ops: PasteOp[];
    step: number;
    detail: string;
    size: number;
  };
}

const live = (vs: Violation[]) =>
  vs.filter((v) => !MASK.some((m) => v.sig.includes(m)));

it("census-paste", async () => {
  const rows = new Map<string, Row>();
  const cov = newCoverage();
  const samples = fc.sample(caseArb, { numRuns: RUNS, seed: SEED });
  let casesWithViolation = 0;
  for (const c of samples) {
    let violations: Violation[];
    try {
      ({ violations } = await replayPaste(buildDoc(c.spec), c.ops, cov));
    } catch (e) {
      // Replay only lets undo and redo throw.
      violations = [{ sig: "throw:history", detail: String(e), step: -1 }];
    }
    const vs = live(violations);
    if (vs.length) casesWithViolation++;
    const seen = new Set<string>();
    for (const v of vs) {
      if (seen.has(v.sig)) continue;
      seen.add(v.sig);
      const size = JSON.stringify(c.spec).length + c.ops.length * 40;
      const r = rows.get(v.sig);
      const witness = {
        spec: c.spec,
        ops: c.ops,
        step: v.step,
        detail: v.detail,
        size,
      };
      if (!r) rows.set(v.sig, { sig: v.sig, count: 1, witness });
      else {
        r.count++;
        if (size < r.witness.size) r.witness = witness;
      }
    }
  }
  const sorted = [...rows.values()].sort((a, b) => b.count - a.count);
  if (process.env.CENSUS_OUT) {
    writeFileSync(
      process.env.CENSUS_OUT,
      JSON.stringify(
        {
          runs: RUNS,
          seed: SEED,
          casesWithViolation,
          coverage: cov,
          rows: sorted,
        },
        null,
        1,
      ),
    );
  }
}, 3_600_000);

it.runIf(process.env.SHRINK_SIGS)(
  "shrink",
  async () => {
    const out: Record<string, unknown> = {};
    for (const target of (process.env.SHRINK_SIGS ?? "").split(",")) {
      const r = await fc.check(
        fc.asyncProperty(caseArb, async (c) => {
          const { violations } = await replayPaste(buildDoc(c.spec), c.ops);
          return !violations.some((v) => v.sig.startsWith(target));
        }),
        { numRuns: Number(process.env.SHRINK_RUNS ?? 1500), seed: SEED },
      );
      if (r.failed && r.counterexample) {
        const c = r.counterexample[0];
        const doc = buildDoc(c.spec);
        const { violations } = await replayPaste(doc, c.ops);
        out[target] = {
          doc,
          ops: c.ops,
          violation: violations.find((v) => v.sig.startsWith(target)) ?? null,
          numRuns: r.numRuns,
        };
      } else out[target] = { notFound: true, numRuns: r.numRuns };
    }
    if (process.env.SHRINK_OUT)
      writeFileSync(process.env.SHRINK_OUT, JSON.stringify(out, null, 1));
  },
  3_600_000,
);
