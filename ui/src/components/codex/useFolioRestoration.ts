import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { Editor, type Range, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import type { CustomEditor } from "#/editor/types";
import type { PageEditorState } from "#/editor/usePageEditor";
import {
  clearFolioRestoration,
  consumeFolioHistoryRestorationRequest,
  type FolioHistoryRestoreRequest,
  type FolioRestoration,
  readFolioHistoryRestorationRequest,
  readFolioHistoryRestorationRequestId,
  readFolioRestoration,
  registerFolioHistoryCapture,
  saveFolioRestoration,
  snapshotTextPoint,
  subscribeFolioHistoryRestorationRequests,
  validateTextPointSnapshot,
} from "#/store/folioRestoration";
import { useWorkspaceStore } from "#/store/workspace";

type RestorationState = {
  tabId: string;
  path: string;
  available: boolean;
  getRevision: () => string;
};

type FolioRestorationOptions = {
  tabId: string;
  path: string;
  /** The page loaded and its content is visible. */
  available: boolean;
  /** A raw Markdown session owns caret state while it is open. */
  rawSessionOpen: boolean;
  editor: Pick<
    PageEditorState,
    "isLoading" | "pageNotFound" | "editorRevision" | "getRevision"
  >;
  bodyRef: RefObject<HTMLDivElement | null>;
  folioEditorRef: RefObject<CustomEditor | null>;
};

type FolioPosition = Omit<FolioRestoration, "revision">;

function snapshotPosition(
  slateEditor: CustomEditor,
  scrollContainer: HTMLElement,
  tabId: string,
  path: string,
): FolioPosition {
  const selection = slateEditor.selection;
  return {
    tabId,
    path,
    scrollTop: scrollContainer.scrollTop,
    anchor: selection ? snapshotTextPoint(slateEditor, selection.anchor) : null,
    focus: selection ? snapshotTextPoint(slateEditor, selection.focus) : null,
  };
}

function isCurrent(
  state: RestorationState,
  tabId: string,
  path: string,
): boolean {
  return state.tabId === tabId && state.path === path && state.available;
}

/** Saves and restores a Folio's scroll and caret across tab switches,
 *  history traversal and in-place editor remounts. */
export function useFolioRestoration({
  tabId,
  path,
  available,
  rawSessionOpen,
  editor,
  bodyRef,
  folioEditorRef,
}: FolioRestorationOptions) {
  const pendingHistoryLocationId = useSyncExternalStore(
    subscribeFolioHistoryRestorationRequests,
    () => readFolioHistoryRestorationRequestId(tabId, path),
  );
  // The state of the latest commit, for callbacks that run outside render.
  const stateRef = useRef<RestorationState | null>(null);
  const lastMountedEditorRef = useRef<CustomEditor | null>(null);
  const consumedHistoryLocationIdRef = useRef<string | null>(null);
  // Decisions taken while the previous commit's state is still current: the
  // swapped-out editor's snapshot and the history request a restore left
  // pending. The commit's first layout effect settles both.
  const swapSnapshotRef = useRef<FolioPosition | null>(null);
  const leftHistoryRequestRef = useRef<FolioHistoryRestoreRequest | null>(null);

  useLayoutEffect(() => {
    stateRef.current = {
      tabId,
      path,
      available,
      getRevision: editor.getRevision,
    };
    const swap = swapSnapshotRef.current;
    swapSnapshotRef.current = null;
    // Entering raw Markdown mode also unmounts the editor; the raw session
    // owns caret state until it exits, so no snapshot belongs there.
    if (
      swap &&
      swap.tabId === tabId &&
      swap.path === path &&
      available &&
      !rawSessionOpen
    ) {
      saveFolioRestoration({ ...swap, revision: editor.getRevision() });
    }
    const left = leftHistoryRequestRef.current;
    leftHistoryRequestRef.current = null;
    if (left && (left.tabId !== tabId || left.path !== path)) {
      consumeFolioHistoryRestorationRequest(left.locationId);
    }
  });

  const buildRestorationSnapshot = useCallback((): FolioRestoration | null => {
    const state = stateRef.current;
    const slateEditor = folioEditorRef.current ?? lastMountedEditorRef.current;
    const scrollContainer = bodyRef.current;
    if (
      !state ||
      !isCurrent(state, tabId, path) ||
      !slateEditor ||
      !scrollContainer
    ) {
      return null;
    }
    return {
      ...snapshotPosition(slateEditor, scrollContainer, tabId, path),
      revision: state.getRevision(),
    };
  }, [bodyRef, folioEditorRef, path, tabId]);

  useLayoutEffect(
    () => registerFolioHistoryCapture(tabId, path, buildRestorationSnapshot),
    [buildRestorationSnapshot, path, tabId],
  );

  // An in-place SlateEditor remount (external content adopt, conflict reload,
  // unlock) destroys the caret. Snapshot selection and focus as the old
  // instance unmounts so the editorRevision-keyed restore effect below can
  // hand them back. bodyRef being empty means the whole folio is unmounting —
  // the folio-level unmount save owns that case (and never records focus, so
  // returning to a tab cannot steal it).
  const onEditorUnmount = useCallback(
    (slateEditor: CustomEditor) => {
      const scrollContainer = bodyRef.current;
      if (!scrollContainer) return;
      swapSnapshotRef.current = {
        ...snapshotPosition(slateEditor, scrollContainer, tabId, path),
        hadFocus: ReactEditor.isFocused(slateEditor),
      };
    },
    [bodyRef, path, tabId],
  );

  useEffect(() => {
    // A revision change can swap the mounted Slate editor without changing this effect's direct inputs.
    void editor.editorRevision;
    if (folioEditorRef.current) {
      lastMountedEditorRef.current = folioEditorRef.current;
    }
  }, [editor.editorRevision, folioEditorRef]);

  useEffect(() => {
    if (!editor.isLoading && !available) {
      clearFolioRestoration(tabId);
    }
  }, [editor.isLoading, available, tabId]);

  useLayoutEffect(
    () => () => {
      const currentTab = useWorkspaceStore
        .getState()
        .tabs.find((tab) => tab.id === tabId);
      if (currentTab?.path !== path) {
        clearFolioRestoration(tabId);
        return;
      }

      const restoration = buildRestorationSnapshot();
      if (!restoration) {
        clearFolioRestoration(tabId);
        return;
      }
      saveFolioRestoration(restoration);
    },
    [buildRestorationSnapshot, path, tabId],
  );

  useLayoutEffect(() => {
    // A revision change remounts the keyed Slate editor and must retry any captured restoration.
    void editor.editorRevision;
    if (
      pendingHistoryLocationId === null &&
      consumedHistoryLocationIdRef.current !== null
    ) {
      consumedHistoryLocationIdRef.current = null;
      return;
    }
    const historyRequest = readFolioHistoryRestorationRequest(tabId, path);
    if (!available) {
      if (!editor.isLoading && editor.pageNotFound && historyRequest) {
        consumeFolioHistoryRestorationRequest(
          historyRequest.request.locationId,
        );
      }
      return;
    }

    const restoration = historyRequest
      ? historyRequest.restoration
      : readFolioRestoration(tabId, path);
    if (!historyRequest && !restoration) return;

    const frame = requestAnimationFrame(() => {
      const state = stateRef.current;
      if (!state || !isCurrent(state, tabId, path)) {
        if (
          historyRequest &&
          state &&
          (state.tabId !== tabId || state.path !== path)
        ) {
          consumeFolioHistoryRestorationRequest(
            historyRequest.request.locationId,
          );
        }
        return;
      }

      const slateEditor = folioEditorRef.current;
      const scrollContainer = bodyRef.current;
      if (!slateEditor || !scrollContainer) return;

      if (restoration) {
        const requireTextMatch = restoration.revision !== editor.getRevision();
        let selection: Range | null = null;
        if (restoration.anchor && restoration.focus) {
          const anchor = validateTextPointSnapshot(
            slateEditor,
            restoration.anchor,
            requireTextMatch,
          );
          const focus = validateTextPointSnapshot(
            slateEditor,
            restoration.focus,
            requireTextMatch,
          );
          if (anchor && focus) selection = { anchor, focus };
        }

        scrollContainer.scrollTop = restoration.scrollTop;
        if (selection) Transforms.select(slateEditor, selection);
        if (restoration.hadFocus) {
          // The user was typing in the swapped-out instance; hand the caret
          // back. When the saved points no longer fit the adopted content,
          // fall back to the end of the document rather than dropping focus.
          if (!selection) {
            Transforms.select(slateEditor, Editor.end(slateEditor, []));
          }
          ReactEditor.focus(slateEditor);
        }
      }

      if (historyRequest) {
        consumedHistoryLocationIdRef.current =
          historyRequest.request.locationId;
        consumeFolioHistoryRestorationRequest(
          historyRequest.request.locationId,
        );
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      // Whether the Folio moved to another tab or path is known only once the
      // next commit's state settles; on unmount nothing settles it.
      if (historyRequest)
        leftHistoryRequestRef.current = historyRequest.request;
    };
  }, [
    bodyRef,
    editor.editorRevision,
    editor.getRevision,
    editor.isLoading,
    editor.pageNotFound,
    folioEditorRef,
    pendingHistoryLocationId,
    path,
    available,
    tabId,
  ]);

  return { onEditorUnmount };
}
