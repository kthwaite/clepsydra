/**
 * Bounded exhaustive oracle: every small list document through save and reload.
 * Reports by first divergence, smallest document first.
 */
import { writeFileSync } from "node:fs";
import type { Descendant } from "slate";
import { it } from "vitest";
import { slateToMarkdown } from "../convert";
import { firstDivergence } from "./census";
import { clone, comparable, makeEditor, reload } from "./harness";

type Leaf = () => Descendant[];
const LEADS: Record<string, Leaf> = {
  plain: () => [{ text: "x" }],
  empty: () => [{ text: "" }],
  space: () => [{ text: " " }],
  bold: () => [{ text: "x", bold: true }],
  link: () =>
    [
      { text: "" },
      { type: "wikilink", target: "W", children: [{ text: "" }] },
      { text: "" },
    ] as Descendant[],
  dash: () => [{ text: "-" }],
  hr: () => [{ text: "---" }],
  num: () => [{ text: "1." }],
  box: () => [{ text: "[ ]" }],
  boxText: () => [{ text: "[x] y" }],
  hash: () => [{ text: "# h" }],
  quote: () => [{ text: "> q" }],
  fence: () => [{ text: "```" }],
  trail: () => [{ text: "x " }],
  lead: () => [{ text: " x" }],
  star: () => [{ text: "*" }],
  stars: () => [{ text: "***" }],
};
const p = (k: string): Descendant =>
  ({ type: "paragraph", children: LEADS[k]() }) as Descendant;
const li = (
  k: string,
  checked: boolean | null,
  ...rest: Descendant[]
): Descendant => {
  const el: Record<string, unknown> = { type: "list-item", children: [p(k), ...rest] };
  if (checked !== null) el.checked = checked;
  return el as unknown as Descendant;
};
const ul = (...c: Descendant[]) =>
  ({ type: "bulleted-list", children: c }) as Descendant;
const ol = (...c: Descendant[]) =>
  ({ type: "numbered-list", children: c }) as Descendant;

it("enumerate", () => {
  const keys = Object.keys(LEADS);
  const checks: (boolean | null)[] = [null, false, true];
  const shapes: [string, (a: Descendant, b: Descendant) => Descendant[]][] = [
    ["one", (a) => [ul(a)]],
    ["oneNum", (a) => [ol(a)]],
    ["two", (a, b) => [ul(a, b)]],
    ["adjacentLists", (a, b) => [ul(a), ul(b)]],
    ["bulletThenNum", (a, b) => [ul(a), ol(b)]],
    ["numThenNum", (a, b) => [ol(a), ol(b)]],
    ["listThenPara", (a) => [ul(a), { type: "paragraph", children: [{ text: "after" }] } as Descendant]],
  ];
  const fails = new Map<string, { n: number; ex: string }>();
  let total = 0;
  const check = (name: string, doc: Descendant[]) => {
    total++;
    let back: Descendant[];
    const md = slateToMarkdown(clone(doc));
    try {
      back = reload(doc);
    } catch (e) {
      const sig = `throw`;
      const r = fails.get(sig) ?? { n: 0, ex: `${name} ${String(e)}` };
      r.n++;
      fails.set(sig, r);
      return;
    }
    // Parser output is loaded unnormalized; leaf boundaries around inline voids
    // are a separate check below. Compare meaning here.
    const a = comparable(makeEditor(doc).children);
    const b = comparable(makeEditor(back).children);
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const sig = `${firstDivergence(a, b)}`;
    const ex = `${name} md=${JSON.stringify(md)} back=${JSON.stringify(b).slice(0, 220)}`;
    const r = fails.get(`${name.split(" ")[0]}|${sig}`) ?? { n: 0, ex };
    r.n++;
    fails.set(`${name.split(" ")[0]}|${sig}`, r);
  };
  for (const a of keys) {
    for (const ca of checks) {
      check(`single ${a}/${ca}`, [ul(li(a, ca))]);
      // Parent with a child, in both types, the child also a task.
      for (const ck of ["plain", "empty", "link"]) {
        for (const cc of checks) {
          check(`parent ${a}/${ca}>${ck}/${cc}`, [ul(li(a, ca, ul(li(ck, cc))))]);
          check(`parentNum ${a}/${ca}>${ck}/${cc}`, [ol(li(a, ca, ol(li(ck, cc))))]);
          check(`parentNumBullet ${a}/${ca}>${ck}/${cc}`, [ol(li(a, ca, ul(li(ck, cc))))]);
          check(`parentTwoKids ${a}/${ca}>${ck}/${cc}`, [ul(li(a, ca, ul(li(ck, cc), li("empty", null))))]);
        }
      }
      // Item followed by a sibling.
      for (const b of ["plain", "empty", "stars"]) {
        for (const [name, f] of shapes) {
          check(`${name} ${a}/${ca},${b}`, f(li(a, ca), li(b, null)));
        }
      }
      // Multi-block items.
      check(`withPara ${a}/${ca}`, [
        ul(li(a, ca, { type: "paragraph", children: [{ text: "second" }] } as Descendant)),
      ]);
      check(`withCode ${a}/${ca}`, [
        ul(li(a, ca, { type: "code-block", children: [{ text: "code" }] } as Descendant)),
      ]);
    }
  }
  const lines = [`total=${total} classes=${fails.size}`];
  for (const [k, v] of [...fails].sort((x, y) => y[1].n - x[1].n)) {
    lines.push(`${v.n}\t${k}\n\t${v.ex}`);
  }
  writeFileSync(process.env.ENUM_OUT ?? "/dev/null", lines.join("\n"));
});
