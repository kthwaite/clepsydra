import { Editor, type Path, type Point, Text } from "slate";

export type TextPointSnapshot = {
  path: Path;
  offset: number;
  text: string;
};

export type FolioRestoration = {
  tabId: string;
  path: string;
  revision: string;
  scrollTop: number;
  anchor: TextPointSnapshot | null;
  focus: TextPointSnapshot | null;
  /** The editor held keyboard focus when the snapshot was taken. Set by the
   *  in-place remount snapshot so restoration can hand the caret back; absent
   *  on tab-switch saves, where restoration must never steal focus. */
  hadFocus?: boolean;
};

export type FolioHistoryDestination = {
  folioTabId: string;
  folioPath: string;
  folioLocationId: string;
};

export type FolioHistoryRestoreRequest = {
  tabId: string;
  path: string;
  locationId: string;
};

const MAX_RECORDS = 16;
const records = new Map<string, FolioRestoration>();

const MAX_HISTORY_RECORDS = 64;
const historyRecords = new Map<string, FolioRestoration>();
let activeCapture: {
  tabId: string;
  path: string;
  capture: () => FolioRestoration | null;
} | null = null;
let pendingHistoryRestoration: FolioHistoryRestoreRequest | null = null;

function clonePoint(point: TextPointSnapshot | null): TextPointSnapshot | null {
  return point
    ? { path: [...point.path], offset: point.offset, text: point.text }
    : null;
}

function cloneRecord(record: FolioRestoration): FolioRestoration {
  return {
    ...record,
    anchor: clonePoint(record.anchor),
    focus: clonePoint(record.focus),
  };
}

export function saveFolioRestoration(record: FolioRestoration): void {
  records.delete(record.tabId);
  records.set(record.tabId, cloneRecord(record));

  if (records.size <= MAX_RECORDS) return;
  const oldestTabId = records.keys().next().value;
  if (oldestTabId !== undefined) records.delete(oldestTabId);
}

export function readFolioRestoration(
  tabId: string,
  path: string,
): FolioRestoration | null {
  const record = records.get(tabId);
  if (!record || record.path !== path) return null;
  return cloneRecord(record);
}

export function clearFolioRestoration(tabId: string): void {
  records.delete(tabId);
}

export function readFolioHistoryDestination(
  state: unknown,
): FolioHistoryDestination | null {
  if (state === null || typeof state !== "object") return null;
  const candidate = state as Record<string, unknown>;
  if (
    typeof candidate.folioTabId !== "string" ||
    typeof candidate.folioPath !== "string" ||
    typeof candidate.folioLocationId !== "string"
  ) {
    return null;
  }
  return {
    folioTabId: candidate.folioTabId,
    folioPath: candidate.folioPath,
    folioLocationId: candidate.folioLocationId,
  };
}

export function registerFolioHistoryCapture(
  tabId: string,
  path: string,
  capture: () => FolioRestoration | null,
): () => void {
  const registration = { tabId, path, capture };
  activeCapture = registration;
  return () => {
    if (activeCapture === registration) activeCapture = null;
  };
}

export function captureFolioHistoryLocation(
  locationId: string,
  tabId: string,
  path: string,
): boolean {
  const registration = activeCapture;
  if (
    !registration ||
    registration.tabId !== tabId ||
    registration.path !== path
  ) {
    return false;
  }

  const record = registration.capture();
  if (!record || record.tabId !== tabId || record.path !== path) return false;

  historyRecords.delete(locationId);
  historyRecords.set(locationId, cloneRecord(record));
  if (historyRecords.size > MAX_HISTORY_RECORDS) {
    const oldestLocationId = historyRecords.keys().next().value;
    if (oldestLocationId !== undefined) {
      historyRecords.delete(oldestLocationId);
    }
  }
  return true;
}

export function readFolioHistoryLocation(
  locationId: string,
  tabId: string,
  path: string,
): FolioRestoration | null {
  const record = historyRecords.get(locationId);
  if (!record || record.tabId !== tabId || record.path !== path) return null;
  return cloneRecord(record);
}

export function requestFolioHistoryRestoration(
  request: FolioHistoryRestoreRequest,
): void {
  pendingHistoryRestoration = { ...request };
}

export function readFolioHistoryRestorationRequest(
  tabId: string,
  path: string,
): {
  request: FolioHistoryRestoreRequest;
  restoration: FolioRestoration | null;
} | null {
  const request = pendingHistoryRestoration;
  if (!request || request.tabId !== tabId || request.path !== path) return null;
  return {
    request: { ...request },
    restoration: readFolioHistoryLocation(request.locationId, tabId, path),
  };
}

export function consumeFolioHistoryRestorationRequest(
  locationId: string,
): void {
  if (pendingHistoryRestoration?.locationId === locationId) {
    pendingHistoryRestoration = null;
  }
}

export function clearFolioHistoryForTab(tabId: string): void {
  for (const [locationId, record] of historyRecords) {
    if (record.tabId === tabId) historyRecords.delete(locationId);
  }
  if (activeCapture?.tabId === tabId) activeCapture = null;
  if (pendingHistoryRestoration?.tabId === tabId) {
    pendingHistoryRestoration = null;
  }
}

export function clearFolioHistoryState(): void {
  historyRecords.clear();
  activeCapture = null;
  pendingHistoryRestoration = null;
}

export function snapshotTextPoint(
  editor: Editor,
  point: Point,
): TextPointSnapshot | null {
  try {
    const [node] = Editor.node(editor, point.path);
    if (
      !Text.isText(node) ||
      point.offset < 0 ||
      point.offset > node.text.length
    ) {
      return null;
    }
    return { path: [...point.path], offset: point.offset, text: node.text };
  } catch {
    return null;
  }
}

export function validateTextPointSnapshot(
  editor: Editor,
  snapshot: TextPointSnapshot,
  requireTextMatch = true,
): Point | null {
  try {
    const [node] = Editor.node(editor, snapshot.path);
    if (
      !Text.isText(node) ||
      (requireTextMatch && node.text !== snapshot.text) ||
      snapshot.offset < 0 ||
      snapshot.offset > node.text.length
    ) {
      return null;
    }
    return { path: [...snapshot.path], offset: snapshot.offset };
  } catch {
    return null;
  }
}
