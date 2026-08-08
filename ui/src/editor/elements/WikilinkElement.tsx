import { type MouseEvent, useRef } from "react";
import { Path } from "slate";
import { ReactEditor, type RenderElementProps, useSlateStatic } from "slate-react";
import { fetchClient } from "#/api/client";
import { useCreatePage } from "#/api/pages";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { WikilinkInlineEditor } from "#/editor/WikilinkInlineEditor";
import { useWikilinkEditing } from "#/editor/wikilinkEditing";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { useOpenTab } from "#/hooks/useOpenTab";
import { generateShortId, intakePath } from "#/lib/intake";

type Props = RenderElementProps & { element: WikilinkElementType };

/** Exact-title comparison key: NFC-normalized, case-folded. */
function titleKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

export function WikilinkElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const controller = useWikilinkEditing();
  const { lookup, refetchAndLookup } = useWikilinkResolution();
  const openTab = useOpenTab();
  const create = useCreatePage();
  // Guards the navigation flow against double-fire while in flight.
  const inFlightRef = useRef(false);

  const path = ReactEditor.findPath(editor, element);
  const activeSession = controller.active;
  const resolved = lookup(element.target);

  const displayText =
    element.alias && element.alias !== element.target
      ? element.alias
      : element.target;

  const openTarget = async (target: string) => {
    if (inFlightRef.current) return;

    const current = lookup(target);
    if (current) {
      openTab("page", current);
      return;
    }

    inFlightRef.current = true;
    try {
      // 1. The index may lag a just-typed link — refetch outlinks once.
      const fresh = await refetchAndLookup(target);
      if (fresh) {
        openTab("page", fresh);
        return;
      }
      // 2. Duplicate guard: the source page may not be reindexed yet, but the
      //    target page can already exist — exact-title match via search.
      const { data } = await fetchClient.GET("/api/vault/index/search", {
        params: { query: { q: target } },
      });
      const wanted = titleKey(target);
      const match = (data ?? []).find(
        (entry) => entry.title != null && titleKey(entry.title) === wanted,
      );
      if (match) {
        openTab("page", match.path);
        return;
      }
      // 3. Truly dangling: create the page (Obsidian convention) and open it.
      const newPath = intakePath({
        kind: "NOTE",
        project: null,
        title: target,
        shortId: generateShortId(),
        now: new Date(),
      });
      await create.mutateAsync({
        params: { path: { path: newPath } },
        body: { title: target },
      });
      openTab("page", newPath);
    } catch {
      // Best-effort flow — on failure the link simply stays dangling.
    } finally {
      inFlightRef.current = false;
    }
  };

  if (
    activeSession !== null &&
    Path.equals(activeSession.path, path)
  ) {
    const draft =
      element.alias === undefined
        ? element.target
        : `${element.target}|${element.alias}`;
    return (
      <span {...attributes}>
        <span
          contentEditable={false}
          className="cl-mono align-baseline text-[0.95em] text-ink"
        >
          <span aria-hidden className="text-accent">
            ⟦
          </span>
          <WikilinkInlineEditor
            initialDraft={draft}
            initialCaret={activeSession.initialCaret}
            returnSide={activeSession.returnSide}
            onCommit={(parsed, exit) => controller.commit(parsed, exit)}
            onCancel={(exit) => controller.cancel(exit)}
            onOpen={(target) => {
              void openTarget(target);
            }}
          />
          <span aria-hidden className="text-accent">
            ⟧
          </span>
        </span>
        {children}
      </span>
    );
  }

  const dangling = resolved === null;
  const linkClassName = dangling
    ? "cl-mono align-baseline text-[0.95em] text-ink-mute underline decoration-dashed underline-offset-2 hover:text-accent"
    : "cl-mono align-baseline text-[0.95em] text-ink hover:text-accent";
  const bracketClassName = dangling ? "text-ink-mute" : "text-accent";

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey) {
      void openTarget(element.target);
    } else {
      controller.begin(path, "end", "after");
    }
  };

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink
          path={resolved ?? undefined}
          onClick={handleClick}
          className={linkClassName}
        >
          <span aria-hidden className={bracketClassName}>
            ⟦
          </span>
          <span className="px-[2px] not-italic">{displayText}</span>
          <span aria-hidden className={bracketClassName}>
            ⟧
          </span>
        </CLink>
      </span>
      {children}
    </span>
  );
}
