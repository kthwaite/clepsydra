import type { PageSummary } from "#/api/types";
import { parseWikilinkDraft } from "#/editor/wikilinkSourceAdapter";
import { findPageByName } from "#/hooks/usePeople";

/** Inline TODO assignment is one page reference, not Task-page free text. */
export function todoAssigneeReference(value: string | undefined) {
  const raw = value?.trim();
  if (!raw || !/^\[\[[^[\]\r\n]+\]\]$/.test(raw)) return null;
  return parseWikilinkDraft(raw.slice(2, -2));
}

export function todoAssigneePerson(
  value: string | undefined,
  people: readonly PageSummary[],
): PageSummary | null {
  const reference = todoAssigneeReference(value);
  const person = reference ? findPageByName(people, reference.target) : null;
  return person?.kind === "PERSON" ? person : null;
}
