import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ComboBox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import type { PageSummary } from "#/api/types";
import { normalizeWikilinkIdentity } from "#/editor/wikilinkIdentity";
import {
  findPageByName,
  pageName,
  useCreatePerson,
  usePeople,
} from "#/hooks/usePeople";
import { cn } from "#/lib/cn";

export interface PersonComboProps {
  /** Receives the person's page name — the `[[wikilink]]` target. */
  onPick: (name: string) => void;
  /** Names already listed; hidden from the options. */
  exclude?: string[];
  disabled?: boolean;
  ariaLabel?: string;
}

type Suggestion =
  | { id: string; kind: "person"; name: string; aliases: string[] }
  | { id: string; kind: "create"; name: string };

const CREATE_ID = "create";

function matches(page: PageSummary, query: string): boolean {
  if (!query) return true;
  return [page.title, page.canonical_name, ...page.aliases]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeWikilinkIdentity(value).includes(query));
}

/** Picks a PERSON page by name, or creates one for a name no page carries.
 *  Enter on an exact match picks it; a partial draft is left alone so the
 *  reader can keep typing or choose from the list. */
export function PersonCombo({
  onPick,
  exclude = [],
  disabled = false,
  ariaLabel = "add attendee",
}: PersonComboProps) {
  const people = usePeople();
  const createPerson = useCreatePerson();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remounting the ComboBox after a pick clears its selection and closes the
  // popover without fighting react-aria's controlled-selection rules. The
  // field stays enabled while a page is being created: disabling it makes
  // react-aria commit and wipe the draft.
  const [epoch, setEpoch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (epoch > 0) inputRef.current?.focus();
  }, [epoch]);

  const excluded = useMemo(
    () => new Set(exclude.map(normalizeWikilinkIdentity)),
    [exclude],
  );
  const query = normalizeWikilinkIdentity(draft);
  const title = draft.trim();

  const suggestions = useMemo<Suggestion[]>(() => {
    const rows: Suggestion[] = people
      .filter(
        (page) =>
          !excluded.has(normalizeWikilinkIdentity(pageName(page))) &&
          matches(page, query),
      )
      .map((page) => ({
        id: page.id,
        kind: "person",
        name: pageName(page),
        aliases: page.aliases,
      }));
    // A name an existing page carries (listed or not) is never created twice.
    if (title && findPageByName(people, title) === null) {
      rows.push({ id: CREATE_ID, kind: "create", name: title });
    }
    return rows;
  }, [people, excluded, query, title]);

  const pick = (name: string) => {
    onPick(name);
    setDraft("");
    setError(null);
    setEpoch((value) => value + 1);
  };

  const create = async (name: string) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await createPerson(name);
      pick(name);
    } catch {
      setError(`Could not create “${name}”`);
    } finally {
      setCreating(false);
    }
  };

  const choose = (id: string) => {
    const suggestion = suggestions.find((row) => row.id === id);
    if (!suggestion) return;
    if (suggestion.kind === "create") void create(suggestion.name);
    else pick(suggestion.name);
  };

  const pickExact = () => {
    const exact = findPageByName(people, title);
    if (!exact || excluded.has(normalizeWikilinkIdentity(pageName(exact)))) {
      return false;
    }
    pick(pageName(exact));
    return true;
  };

  return (
    <div className="flex min-w-[80px] flex-1 flex-col gap-1">
      <ComboBox
        key={epoch}
        aria-label={ariaLabel}
        menuTrigger="focus"
        allowsCustomValue
        isDisabled={disabled}
        inputValue={draft}
        onInputChange={setDraft}
        items={suggestions}
        onSelectionChange={(key) => {
          if (key != null) choose(String(key));
        }}
        className="min-w-0"
      >
        <Input
          ref={inputRef}
          onKeyDown={(event) => {
            // A focused option belongs to react-aria; only a bare Enter on a
            // typed name is ours.
            if (
              event.key === "Enter" &&
              !event.currentTarget.getAttribute("aria-activedescendant") &&
              pickExact()
            ) {
              event.preventDefault();
            }
          }}
          className={cn(
            "h-[30px] w-full bg-transparent px-0.5 text-[13.5px] text-ink outline-none",
            "data-[focus-visible]:ring-[1.5px] data-[focus-visible]:ring-accent data-[focus-visible]:ring-inset",
            "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
          )}
        />
        <Popover className="w-[280px] min-w-(--trigger-width) rounded-[14px] bg-raise p-1.5 shadow-lg outline-none">
          <ListBox<Suggestion> className="max-h-[280px] overflow-auto outline-none">
            {(item) => (
              <ListBoxItem
                id={item.id}
                textValue={item.name}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[9px] px-3 py-1.5 text-[14px] text-ink-2 outline-none",
                  "data-[hovered]:bg-sink data-[hovered]:text-ink",
                  "data-[focused]:bg-sink data-[focused]:text-ink",
                  "data-[selected]:text-ink",
                )}
              >
                {item.kind === "create" ? (
                  <span className="flex items-center gap-2 text-accent">
                    <Plus size={12} strokeWidth={2} aria-hidden />
                    Create “{item.name}”
                  </span>
                ) : (
                  <>
                    <span>{item.name}</span>
                    {item.aliases.length > 0 && (
                      <span className="text-[12.5px] text-mute">
                        {item.aliases.join(" · ")}
                      </span>
                    )}
                  </>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      {creating && <div className="text-[12.5px] text-mute">Creating…</div>}
      {error && <div className="text-[12.5px] text-hot">{error}</div>}
    </div>
  );
}
