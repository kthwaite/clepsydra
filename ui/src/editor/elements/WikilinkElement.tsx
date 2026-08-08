import { useRef } from "react";
import type { RenderElementProps } from "slate-react";
import { fetchClient } from "#/api/client";
import { useCreatePage } from "#/api/pages";
import { CLink } from "#/components/codex/CLink";
import type { WikilinkElement as WikilinkElementType } from "#/editor/types";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { useOpenTab } from "#/hooks/useOpenTab";
import { generateShortId, intakePath } from "#/lib/intake";

type Props = RenderElementProps & { element: WikilinkElementType };

/** Exact-title comparison key: NFC-normalized, case-folded. */
function titleKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

export function WikilinkElement({ attributes, children, element }: Props) {
  const { lookup, refetchAndLookup } = useWikilinkResolution();
  const openTab = useOpenTab();
  const create = useCreatePage();
  // Guards the dangling-click flow against double-fire while in flight.
  const inFlightRef = useRef(false);

  const resolved = lookup(element.target);

  const displayText =
    element.alias && element.alias !== element.target
      ? element.alias
      : element.target;

  const handleDanglingClick = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const target = element.target;
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
      const path = intakePath({
        kind: "NOTE",
        project: null,
        title: target,
        shortId: generateShortId(),
        now: new Date(),
      });
      await create.mutateAsync({
        params: { path: { path } },
        body: { title: target },
      });
      openTab("page", path);
    } catch {
      // Best-effort flow — on failure the link simply stays dangling.
    } finally {
      inFlightRef.current = false;
    }
  };

  const dangling = resolved === null;
  const clinkProps = dangling
    ? {
        onClick: () => {
          void handleDanglingClick();
        },
      }
    : { path: resolved };
  const linkClassName = dangling
    ? "cl-mono align-baseline text-[0.95em] text-ink-mute underline decoration-dashed underline-offset-2 hover:text-accent"
    : "cl-mono align-baseline text-[0.95em] text-ink hover:text-accent";
  const bracketClassName = dangling ? "text-ink-mute" : "text-accent";

  return (
    <span {...attributes}>
      <span contentEditable={false}>
        <CLink {...clinkProps} className={linkClassName}>
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
