/**
 * Violation census: samples many histories and groups violations by signature,
 * keeping the smallest witness for each. Run with CENSUS_RUNS / CENSUS_OUT /
 * CENSUS_SEED; the census itself asserts nothing unless CENSUS_STRICT is set.
 */
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { it } from "vitest";
import type { Descendant } from "slate";
import { slateToMarkdown } from "../convert";
import { continuation, firstDivergence, replay, type Violation } from "./census";
import {
  arbDoc,
  arbOps,
  buildDoc,
  clone,
  comparable,
  OP_KINDS,
  type Op,
  type OpKind,
  reload,
} from "./harness";

const stable = (d: Descendant[]) =>
  JSON.stringify(comparable(reload(d))) === JSON.stringify(comparable(d));

const RUNS = Number(process.env.CENSUS_RUNS ?? 300);
const SEED = Number(process.env.CENSUS_SEED ?? 20261104);
const MASK = (process.env.CENSUS_MASK ?? "").split(",").filter(Boolean);
const PROFILE = process.env.CENSUS_PROFILE ?? "all";

const profileArb = fc.record(
  PROFILE === "canonical"
    ? {
        voids: fc.constant(false),
        extras: fc.constant(false),
        tasks: fc.boolean(),
        empties: fc.boolean(),
      }
    : {
        voids: fc.boolean(),
        extras: fc.boolean(),
        tasks: fc.boolean(),
        empties: fc.boolean(),
      },
);

const DISABLED = new Set((process.env.CENSUS_NO_OPS ?? "").split(",").filter(Boolean));
const kinds = OP_KINDS.filter((k) => !DISABLED.has(k));

const caseArb = fc
  .tuple(
    profileArb,
    fc.subarray([...kinds] as OpKind[], { minLength: 2 }),
  )
  .chain(([p, enabled]) =>
    fc.record({
      spec: arbDoc(p),
      ops: arbOps(enabled, ["a", "b", " "], 12),
      enabled: fc.constant(enabled),
    }),
  );

/** `chain` shrinks poorly; a fixed profile lets shrinking remove structure. */
const shrinkArb = fc.record({
  spec: arbDoc({ voids: true, extras: true, tasks: true, empties: true }),
  ops: arbOps(kinds, ["a", "b", " "], 12),
  enabled: fc.constant([...kinds] as OpKind[]),
});

interface Row {
  sig: string;
  count: number;
  first: number;
  witness: { spec: unknown; ops: Op[]; step: number; detail: string; size: number };
}

it(
  "census",
  async () => {
    const rows = new Map<string, Row>();
    const samples = fc.sample(caseArb, { numRuns: RUNS, seed: SEED });
    let totalOps = 0;
    const observed: Record<string, number> = {};
    const note = (vs: Violation[], c: (typeof samples)[number]) => {
      const live = vs.filter((v) => !MASK.some((m) => v.sig.startsWith(m)));
      const seen = new Set<string>();
      live.forEach((v, i) => {
        const size = JSON.stringify(c.spec).length + c.ops.length * 40;
        const r = rows.get(v.sig);
        if (seen.has(v.sig)) return;
        seen.add(v.sig);
        if (!r) {
          rows.set(v.sig, {
            sig: v.sig,
            count: 1,
            first: i === 0 ? 1 : 0,
            witness: { spec: c.spec, ops: c.ops, step: v.step, detail: v.detail, size },
          });
        } else {
          r.count++;
          if (i === 0) r.first++;
          if (size < r.witness.size) {
            r.witness = { spec: c.spec, ops: c.ops, step: v.step, detail: v.detail, size };
          }
        }
      });
    };
    for (const c of samples) {
      const doc = buildDoc(c.spec);
      totalOps += c.ops.length;
      for (const o of c.ops) observed[o.k] = (observed[o.k] ?? 0) + 1;
      const { violations } = await replay(doc, c.ops, { stepUndo: true });
      note(violations, c);
      if (!stable(doc)) {
        const cls = firstDivergence(comparable(doc), comparable(reload(doc)));
        note([{ sig: `start-unstable:${cls}`, detail: slateToMarkdown(clone(doc)), step: -1 }], c);
      }
      const hist = c.ops.filter((o) => o.k !== "undo" && o.k !== "redo");
      if (hist.length >= 2) {
        const mid = Math.floor(hist.length / 2);
        const m = await continuation(doc, hist.slice(0, mid), hist.slice(mid));
        if (m) note([m], c);
      }
    }
    const sorted = [...rows.values()].sort((a, b) => b.first - a.first || b.count - a.count);
    const lines = [
      `runs=${RUNS} seed=${SEED} ops=${totalOps} signatures=${sorted.length}`,
      `op mix: ${JSON.stringify(observed)}`,
      ...sorted.map((r) => `${String(r.first).padStart(5)} ${String(r.count).padStart(5)}  ${r.sig}`),
    ];
    console.log(lines.join("\n"));
    if (process.env.CENSUS_OUT) {
      writeFileSync(process.env.CENSUS_OUT, JSON.stringify(sorted, null, 1));
    }
  },
  3_600_000,
);

/**
 * Shrinks a witness per signature prefix. Set SHRINK_SIGS (comma separated);
 * writes the minimised cases to SHRINK_OUT.
 */
it.runIf(process.env.SHRINK_SIGS)(
  "shrink",
  async () => {
    const out: Record<string, unknown> = {};
    for (const target of (process.env.SHRINK_SIGS ?? "").split(",")) {
      const hits = (vs: Violation[]) =>
        vs.find((v) => v.sig.startsWith(target));
      const r = await fc.check(
        fc.asyncProperty(shrinkArb, async (c) => {
          const doc = buildDoc(c.spec);
          if (target.startsWith("start-unstable")) {
            if (stable(doc)) return true;
            const cls = firstDivergence(comparable(doc), comparable(reload(doc)));
            return !`start-unstable:${cls}`.startsWith(target);
          }
          const { violations } = await replay(doc, c.ops, { stepUndo: true });
          if (hits(violations)) return false;
          if (target.startsWith("continuation")) {
            const hist = c.ops.filter((o) => o.k !== "undo" && o.k !== "redo");
            if (hist.length < 2) return true;
            const mid = Math.floor(hist.length / 2);
            const m = await continuation(doc, hist.slice(0, mid), hist.slice(mid));
            return !m;
          }
          return true;
        }),
        { numRuns: Number(process.env.SHRINK_RUNS ?? 1500), seed: SEED },
      );
      if (r.failed && r.counterexample) {
        const c = r.counterexample[0];
        const doc = buildDoc(c.spec);
        const { violations } = await replay(doc, c.ops, { stepUndo: true });
        out[target] = {
          md: slateToMarkdown(clone(doc)),
          doc,
          ops: c.ops,
          violation: hits(violations) ?? null,
          numRuns: r.numRuns,
        };
      } else out[target] = { notFound: true, numRuns: r.numRuns };
    }
    if (process.env.SHRINK_OUT) {
      writeFileSync(process.env.SHRINK_OUT, JSON.stringify(out, null, 1));
    }
  },
  3_600_000,
);
