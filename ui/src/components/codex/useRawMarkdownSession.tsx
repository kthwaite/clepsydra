import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import type { PageEditorState } from "#/editor/usePageEditor";
import { registerFolioHistoryTraversalGuard } from "#/hooks/useFolioHistoryNavigation";
import { registerWorkspaceTransitionGuard } from "#/store/workspace";

export type RawMarkdownSession = {
  path: string;
  entryRevision: string;
  snapshot: string;
  value: string;
  diagnostic: string | null;
};

function rawMarkdownApplyDiagnostic(error: unknown) {
  const detail =
    error instanceof Error && error.message.trim() ? `: ${error.message}` : "";
  return `Raw Markdown could not be applied${detail}. Fix the Markdown and try again.`;
}

export function RawMarkdownNavigationGuard({
  dirty,
  onLeave,
}: {
  dirty: boolean;
  onLeave: () => void;
}) {
  const leaveApprovedRef = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !leaveApprovedRef.current,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  const pendingTransitionRef = useRef<{ proceed: () => void } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{
    proceed: () => void;
  } | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const guard = (proceed: () => void) => {
      if (leaveApprovedRef.current) return false;
      const pending = { proceed };
      pendingTransitionRef.current = pending;
      setPendingTransition(pending);
      leaveApprovedRef.current = false;
      return true;
    };
    const unregisterWorkspaceGuard = registerWorkspaceTransitionGuard(guard);
    const unregisterHistoryGuard = registerFolioHistoryTraversalGuard(guard);
    return () => {
      unregisterWorkspaceGuard();
      unregisterHistoryGuard();
    };
  }, [dirty]);

  const stay = () => {
    pendingTransitionRef.current = null;
    leaveApprovedRef.current = false;
    setPendingTransition(null);
    if (blocker.status === "blocked") blocker.reset?.();
  };
  const leave = () => {
    const pending = pendingTransitionRef.current;
    if (!pending && blocker.status !== "blocked") return;
    pendingTransitionRef.current = null;
    leaveApprovedRef.current = true;
    setPendingTransition(null);
    onLeave();
    if (pending) pending.proceed();
    else blocker.proceed?.();
  };

  return (
    <Dialog
      isOpen={blocker.status === "blocked" || pendingTransition !== null}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
      title="Unsaved raw Markdown"
      description="Leaving now will discard the raw Markdown draft."
      footer={
        <>
          <Button variant="secondary" onPress={stay}>
            Stay
          </Button>
          <Button variant="danger" onPress={leave}>
            Leave
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-mute">
        This raw draft exists only in this browser until you Apply it.
      </p>
    </Dialog>
  );
}

type RawMarkdownSessionOptions = {
  path: string;
  editor: Pick<
    PageEditorState,
    "getPlaintext" | "getRevision" | "setBodyMarkdown"
  >;
  /** Runs after the draft becomes the editor's body. */
  onApplied?: (markdown: string) => void;
};

/** A raw Markdown draft of the Folio body, opened from and applied back to
 *  the page editor. */
export function useRawMarkdownSession({
  path,
  editor,
  onApplied,
}: RawMarkdownSessionOptions) {
  const [session, setSession] = useState<RawMarkdownSession | null>(null);
  useEffect(() => {
    setSession((current) => {
      if (
        !current ||
        current.path === path ||
        current.value !== current.snapshot
      ) {
        return current;
      }
      return null;
    });
  }, [path]);

  const diagnose = (diagnostic: string) =>
    setSession((current) => (current ? { ...current, diagnostic } : current));

  // Callers offer open only while raw mode is available.
  const open = () => {
    const snapshot = editor.getPlaintext();
    setSession({
      path,
      entryRevision: editor.getRevision(),
      snapshot,
      value: snapshot,
      diagnostic: null,
    });
  };
  const change = (value: string) =>
    setSession((current) =>
      current ? { ...current, value, diagnostic: null } : current,
    );
  const apply = (editable: boolean) => {
    if (!session) return;
    if (!editable) {
      diagnose(
        "This Folio is no longer editable. Keep or copy this raw Markdown draft, then return to Edit before applying.",
      );
      return;
    }
    if (
      session.path !== path ||
      editor.getRevision() !== session.entryRevision
    ) {
      diagnose(
        "This Folio changed after raw Markdown mode opened. Keep or copy this draft, then reopen raw mode before applying.",
      );
      return;
    }
    try {
      editor.setBodyMarkdown(session.value);
      onApplied?.(session.value);
      setSession(null);
    } catch (error) {
      diagnose(rawMarkdownApplyDiagnostic(error));
    }
  };
  const discard = () => setSession(null);

  return {
    session,
    dirty: session !== null && session.value !== session.snapshot,
    open,
    change,
    apply,
    discard,
  };
}
