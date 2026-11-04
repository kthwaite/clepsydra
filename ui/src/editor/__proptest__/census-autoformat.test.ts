/**
 * Autoformat census. Two passes, grouped by signature with the shortest witness:
 *   matrix  every state x position x token x follow-up (exhaustive, deterministic)
 *   random  fast-check histories of several hazards over generated documents
 *
 *   CENSUS_OUT=/tmp/x.json bunx vitest run src/editor/__proptest__/census-autoformat.test.ts
 * Env: CENSUS_RUNS (random cases, default 3000), CENSUS_SEED, CENSUS_MATRIX=0 skips the matrix,
 * CENSUS_NO_MASK=1 stops skipping the reload checks for root causes already written up.
 */
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { Editor, Range, Transforms } from "slate";
import type { HistoryEditor } from "slate-history";
import { it } from "vitest";
import { continuation } from "./census";
import {
  checkReload,
  contentBag,
  FOLLOWS,
  POSITIONS,
  reloadStable,
  runCase,
  STATES,
  TOKENS,
  type Violation,
} from "./census-autoformat";
import {
  applyOp,
  arbDoc,
  buildDoc,
  type Caret,
  canonical,
  clone,
  makeEditor,
  type Op,
  shapeViolations,
  tick,
} from "./harness";

const RUNS = Number(process.env.CENSUS_RUNS ?? 3000);
const SEED = Number(process.env.CENSUS_SEED ?? 20261104);

interface Row {
  sig: string;
  count: number;
  witness: string;
  tags: Set<string>;
}

const rows = new Map<string, Row>();
const note = (vs: Violation[], tag: string) => {
  for (const v of vs) {
    const r = rows.get(v.sig);
    if (!r)
      rows.set(v.sig, {
        sig: v.sig,
        count: 1,
        witness: v.detail,
        tags: new Set([tag]),
      });
    else {
      r.count++;
      r.tags.add(tag);
      if (v.detail.length < r.witness.length) r.witness = v.detail;
    }
  }
};

const coverage: Record<string, Record<string, number>> = {};
const bump = (group: string, key: string) => {
  coverage[group] ??= {};
  coverage[group][key] = (coverage[group][key] ?? 0) + 1;
};

/** What the document turned into, so "no findings" can be told from "no reach". */
function reached(e: Editor) {
  const seen = new Set<string>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (o.bold) seen.add("bold");
    if (o.italic) seen.add("italic");
    if (o.strikethrough) seen.add("strike");
    if (o.code) seen.add("code");
    if (typeof o.type === "string") seen.add(o.type);
    if (o.properties) seen.add("properties");
    if (o.checked === true || o.checked === false) seen.add("task");
    if (Array.isArray(o.children)) o.children.forEach(walk);
  };
  e.children.forEach(walk);
  return seen;
}

const HAZARD_TEXT = TOKENS.map((t) => t.text);

const arbCaret: fc.Arbitrary<Caret> = fc.oneof(
  fc.record({
    at: fc.constantFrom("start" as const, "end" as const),
    line: fc.nat(12),
  }),
  fc.record({
    at: fc.constant("mid" as const),
    line: fc.nat(12),
    off: fc.nat(6),
  }),
);

type Step =
  | { s: "token"; text: string }
  | { s: "caret"; c: Caret }
  | {
      s: "op";
      k:
        | "enter"
        | "bs"
        | "del"
        | "tab"
        | "untab"
        | "undo"
        | "redo"
        | "toggle"
        | "up"
        | "down";
    };

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .constantFrom(...HAZARD_TEXT)
      .map((text): Step => ({ s: "token", text })),
  },
  { weight: 2, arbitrary: arbCaret.map((c): Step => ({ s: "caret", c })) },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(
        "enter",
        "bs",
        "del",
        "tab",
        "untab",
        "undo",
        "redo",
        "toggle",
        "up",
        "down",
      )
      .map((k): Step => ({ s: "op", k: k as "enter" })),
  },
);

const randomCase = fc.record({
  spec: fc
    .record({
      voids: fc.boolean(),
      extras: fc.boolean(),
      tasks: fc.boolean(),
      empties: fc.boolean(),
    })
    .chain((p) => arbDoc(p)),
  curated: fc.option(fc.nat(STATES.length - 1), { nil: null }),
  steps: fc.array(arbStep, { minLength: 1, maxLength: 6 }),
});

function outlineTag(steps: Step[]) {
  return JSON.stringify(
    steps.map((s) =>
      s.s === "token" ? s.text : s.s === "op" ? s.k : `@${s.c.at}${s.c.line}`,
    ),
  );
}

// Takes minutes, so a plain test run skips it; set CENSUS_OUT to run it.
it.runIf(process.env.CENSUS_OUT)(
  "autoformat census",
  async () => {
    const started = Date.now();
    let matrixCases = 0;
    if (process.env.CENSUS_MATRIX !== "0") {
      for (const state of STATES) {
        for (const pos of POSITIONS) {
          for (const token of TOKENS) {
            for (const follow of FOLLOWS) {
              matrixCases++;
              bump("state", state.name);
              bump("token", token.text);
              bump("follow", follow);
              const vs = await runCase(state, pos, token, follow, {
                stepUndo: follow === "none",
                onToken:
                  follow === "none"
                    ? (e, st, ps, tk) => {
                        for (const seen of reached(e))
                          bump("matrixReached", seen);
                        const literal =
                          Editor.string(e, []).includes(tk.text.trim()) &&
                          tk.text.trim() !== "";
                        bump(
                          literal ? "tokenStayedLiteral" : "tokenTransformed",
                          tk.text,
                        );
                        bump(
                          literal ? "ctxStayedLiteral" : "ctxTransformed",
                          `${st.ctx}/${ps}`,
                        );
                      }
                    : undefined,
              });
              note(vs, `${state.name}/${pos}`);
            }
          }
        }
      }
    }
    const matrixMs = Date.now() - started;

    const samples = fc.sample(randomCase, { numRuns: RUNS, seed: SEED });
    let randomOps = 0;
    for (const c of samples) {
      const doc = c.curated !== null ? STATES[c.curated].doc : buildDoc(c.spec);
      const e = makeEditor(doc);
      Transforms.select(e, Editor.start(e, []));
      e.history = { undos: [], redos: [] };
      await tick();
      const start = clone(e.children);
      const out: Violation[] = [];
      const tag = outlineTag(c.steps);
      let threw = false;
      const flatOps: Op[] = [];
      for (const step of c.steps) {
        randomOps++;
        const preSv = shapeViolations(e).length;
        const preBag = contentBag(e.children);
        const preDoc = clone(e.children);
        const preStable = reloadStable(preDoc);
        try {
          if (step.s === "token") {
            const token = TOKENS.find((t) => t.text === step.text);
            const selectedBefore = e.selection && Range.isExpanded(e.selection);
            for (const ch of step.text) {
              const op: Op = { k: "type", ch };
              flatOps.push(op);
              applyOp(e, op);
              await tick();
            }
            bump("randomToken", step.text);
            if (token && !selectedBefore) {
              const want = [...(preBag + token.letters)].sort().join("");
              const consumed =
                (token.kind === "listMark" ||
                  token.kind === "taskMark" ||
                  token.text.includes("[k:: v]")) &&
                contentBag(e.children).length <= want.length &&
                contentBag(e.children).length >= preBag.length;
              if (contentBag(e.children) !== want && !consumed) {
                out.push({
                  sig: `random:lost-typed:${step.text}`,
                  detail: `${tag} want=${want} got=${contentBag(e.children)} pre=${JSON.stringify(preDoc)} post=${JSON.stringify(e.children)}`,
                });
              }
            }
          } else if (step.s === "caret") {
            const op: Op = { k: "caret", c: step.c };
            flatOps.push(op);
            applyOp(e, op);
            await tick();
          } else {
            const op: Op = { k: step.k };
            flatOps.push(op);
            applyOp(e, op);
            await tick();
            if (
              (step.k === "enter" || step.k === "tab" || step.k === "untab") &&
              contentBag(e.children) !== preBag
            ) {
              out.push({
                sig: `random:lost-after:${step.k}`,
                detail: `${tag} pre=${JSON.stringify(preDoc)} post=${JSON.stringify(e.children)}`,
              });
            }
          }
        } catch (err) {
          out.push({
            sig: `random:throw:${step.s === "op" ? step.k : "type"}`,
            detail: `${tag} ${String(err)} pre=${JSON.stringify(preDoc)}`,
          });
          threw = true;
          break;
        }
        const sv = shapeViolations(e);
        if (sv.length && preSv === 0) {
          out.push({
            sig: `random:shape:${step.s === "op" ? step.k : "type"}:${sv[0]}`,
            detail: `${tag} pre=${JSON.stringify(preDoc)} post=${JSON.stringify(e.children)}`,
          });
        }
        if (preStable && (step.s === "op" || step.s === "token")) {
          checkReload(
            clone(e.children),
            `random ${tag}`,
            "seq",
            { text: step.s === "token" ? step.text : `op:${step.k}` },
            out,
          );
        }
        for (const seen of reached(e)) bump("reached", seen);
      }
      if (!threw) {
        const h = e as HistoryEditor;
        const end = clone(e.children);
        let undone = 0;
        while (h.history.undos.length > 0 && undone < 500) {
          h.undo();
          undone++;
          await tick();
        }
        const keyed = (v: unknown) =>
          JSON.stringify(v, (_k, x) =>
            x && typeof x === "object" && !Array.isArray(x)
              ? Object.fromEntries(
                  Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
                )
              : x,
          );
        if (keyed(canonical(e.children)) !== keyed(canonical(start))) {
          out.push({
            sig: "random:undo-all",
            detail: `${tag} start=${JSON.stringify(start)} got=${JSON.stringify(e.children)}`,
          });
        } else {
          for (let i = 0; i < undone; i++) {
            h.redo();
            await tick();
          }
          if (JSON.stringify(e.children) !== JSON.stringify(end)) {
            out.push({
              sig: "random:redo-all",
              detail: `${tag} want=${JSON.stringify(end)} got=${JSON.stringify(e.children)}`,
            });
          }
        }
        // Metamorphic: reloading between two runs of typing changes nothing.
        const hist = flatOps.filter((o) => o.k !== "undo" && o.k !== "redo");
        if (hist.length >= 2) {
          try {
            const m = await continuation(
              doc,
              hist.slice(0, Math.floor(hist.length / 2)),
              hist.slice(Math.floor(hist.length / 2)),
            );
            // Trailing empty paragraphs vanish on reload (known, out of scope).
            const split = m?.detail.split(" reloaded=") ?? [];
            const liveMd =
              split.length === 2
                ? JSON.parse(split[0].slice(split[0].indexOf("live=") + 5))
                : null;
            const backMd = split.length === 2 ? JSON.parse(split[1]) : null;
            const squash = (t: string) => t.replace(/\s+/g, " ").trim();
            const trivial =
              liveMd !== null && squash(liveMd) === squash(backMd);
            if (m && !trivial)
              out.push({
                sig: `random:${m.sig}`,
                detail: `${tag} ${m.detail}`,
              });
          } catch (err) {
            out.push({
              sig: "random:continuation-throw",
              detail: `${tag} ${String(err)}`,
            });
          }
        }
      }
      note(out, tag);
    }

    const list = [...rows.values()].sort((a, b) => b.count - a.count);
    const report = {
      matrixCases,
      matrixMs,
      randomCases: samples.length,
      randomOps,
      totalMs: Date.now() - started,
      coverage,
      rows: list.map((r) => ({
        sig: r.sig,
        count: r.count,
        tags: [...r.tags].slice(0, 12),
        nTags: r.tags.size,
        witness: r.witness,
      })),
    };
    if (process.env.CENSUS_OUT)
      writeFileSync(process.env.CENSUS_OUT, JSON.stringify(report, null, 1));
  },
  3_600_000,
);
