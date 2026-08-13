import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFolioHistoryState,
  readFolioHistoryRestorationRequest,
  requestFolioHistoryRestoration,
} from "#/store/folioRestoration";
import { useWorkspaceStore } from "#/store/workspace";
import { createVaultIdentity, wrapIdentity } from "../age";
import {
  type EncryptionActions,
  EncryptionProvider,
  useEncryptionActions,
  useEncryptionStatus,
} from "../EncryptionProvider";
import { EncryptionSession } from "../session";
import fixtureIdentityFile from "./fixtures/interop.identity.txt?raw";

const fixtureIdentity = fixtureIdentityFile
  .split("\n")
  .find((line) => line.startsWith("AGE-SECRET-KEY-"));

if (!fixtureIdentity) {
  throw new Error("fixture identity is missing");
}

const configHook = vi.hoisted(() => ({
  value: {
    data: {
      initialized: true,
      key_id: "019fd000-0000-7000-8000-000000000504",
      recipient:
        "age1x8q5k7397p3jwr4jjt2v428g2k8y5kkpy8gnj0hwrmvn8zujtfsq8lq7y7",
      wrapped_identity: null as string | null,
      revision: "fixture-revision",
    },
    isPending: false,
    error: null as Error | null,
  },
}));

vi.mock("#/api/encryption", () => ({
  useEncryptionConfig: () => configHook.value,
}));

beforeEach(() => {
  configHook.value = {
    data: {
      initialized: true,
      key_id: "019fd000-0000-7000-8000-000000000504",
      recipient:
        "age1x8q5k7397p3jwr4jjt2v428g2k8y5kkpy8gnj0hwrmvn8zujtfsq8lq7y7",
      wrapped_identity: null,
      revision: "fixture-revision",
    },
    isPending: false,
    error: null,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let latestActions: EncryptionActions | null = null;
let actionRenderCount = 0;
let statusRenderCount = 0;

function ActionsProbe() {
  const actions = useEncryptionActions();
  actionRenderCount += 1;
  useEffect(() => {
    latestActions = actions;
  }, [actions]);
  return null;
}

function StatusProbe() {
  const status = useEncryptionStatus();
  statusRenderCount += 1;
  return (
    <output data-testid="encryption-status">
      {status.status}|{status.keyId ?? "none"}|{status.error ?? "none"}|
      {status.lockEpoch}
    </output>
  );
}

function Harness({ children }: { children?: ReactNode }) {
  return (
    <EncryptionProvider>
      <ActionsProbe />
      <StatusProbe />
      {children}
    </EncryptionProvider>
  );
}

describe("EncryptionSession", () => {
  it("keeps identity and passwords out of serialized state and browser storage", async () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const sessionSet = vi.spyOn(window.sessionStorage, "setItem");
    const session = new EncryptionSession();

    await session.unlockWithImportedIdentity(fixtureIdentity);
    const serialized = JSON.stringify(session);

    expect(serialized).not.toContain(fixtureIdentity);
    expect(serialized.toLowerCase()).not.toContain("password");
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(session.getIdentity()).toBe(fixtureIdentity);

    session.clear();
    expect(session.getIdentity()).toBeNull();
  });

  it("does not retain a password and remains locked after a wrong password", async () => {
    const { identity } = await createVaultIdentity();
    const wrapped = await wrapIdentity(identity, "correct-password-value");
    const session = new EncryptionSession();

    await expect(
      session.unlockWithPassword(wrapped, "wrong-password-value"),
    ).rejects.toThrow();

    expect(session.getIdentity()).toBeNull();
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("correct-password-value");
    expect(serialized).not.toContain("wrong-password-value");
  });
});

describe("EncryptionProvider", () => {
  beforeEach(() => {
    latestActions = null;
    actionRenderCount = 0;
    statusRenderCount = 0;
  });

  it("keeps actions stable while primitive status consumers update", async () => {
    render(<Harness />);
    await waitFor(() => expect(latestActions).not.toBeNull());
    const actions = latestActions!;
    const actionRendersBefore = actionRenderCount;
    const statusRendersBefore = statusRenderCount;

    await act(async () => {
      await actions.unlockWithImportedIdentity(fixtureIdentity);
    });

    expect(latestActions).toBe(actions);
    expect(actionRenderCount).toBe(actionRendersBefore);
    expect(statusRenderCount).toBeGreaterThan(statusRendersBefore);
    expect(screen.getByTestId("encryption-status")).toHaveTextContent(
      "unlocked|019fd000-0000-7000-8000-000000000504|none|0",
    );
  });

  it("flushes every editor before dropping the identity", async () => {
    render(<Harness />);
    await waitFor(() => expect(latestActions).not.toBeNull());
    const actions = latestActions!;
    await act(async () => {
      await actions.unlockWithImportedIdentity(fixtureIdentity);
    });
    const first = deferred();
    const second = deferred();
    const firstFlusher = vi.fn(() => first.promise);
    const secondFlusher = vi.fn(() => second.promise);
    actions.registerFlusher(firstFlusher);
    actions.registerFlusher(secondFlusher);

    const locking = actions.lock();
    await waitFor(() => {
      expect(firstFlusher).toHaveBeenCalledOnce();
      expect(secondFlusher).toHaveBeenCalledOnce();
    });
    expect(actions.getIdentity()).toBe(fixtureIdentity);

    first.resolve();
    await first.promise;
    expect(actions.getIdentity()).toBe(fixtureIdentity);

    let locked = false;
    await act(async () => {
      second.resolve();
      locked = await locking;
    });
    expect(locked).toBe(true);
    expect(actions.getIdentity()).toBeNull();
    expect(screen.getByTestId("encryption-status")).toHaveTextContent(
      "locked|019fd000-0000-7000-8000-000000000504|none|1",
    );
  });

  it("refuses to lock when a flusher fails and honors unregister", async () => {
    render(<Harness />);
    await waitFor(() => expect(latestActions).not.toBeNull());
    const actions = latestActions!;
    await act(async () => {
      await actions.unlockWithImportedIdentity(fixtureIdentity);
    });
    const failing = vi.fn(() =>
      Promise.reject(new Error("SENSITIVE_FLUSH_ERROR")),
    );
    const unregisterFailing = actions.registerFlusher(failing);

    let locked = true;
    await act(async () => {
      locked = await actions.lock();
    });
    expect(locked).toBe(false);
    expect(actions.getIdentity()).toBe(fixtureIdentity);
    expect(screen.getByTestId("encryption-status").textContent).not.toContain(
      "SENSITIVE_FLUSH_ERROR",
    );

    unregisterFailing();
    const removed = vi.fn(() => Promise.resolve());
    const unregisterRemoved = actions.registerFlusher(removed);
    unregisterRemoved();
    await act(async () => {
      locked = await actions.lock();
    });
    expect(locked).toBe(true);
    expect(removed).not.toHaveBeenCalled();
    expect(actions.getIdentity()).toBeNull();
  });

  it("deduplicates idle listeners through a StrictMode mount cycle", async () => {
    const addWindow = vi.spyOn(window, "addEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const addDocument = vi.spyOn(document, "addEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");

    const view = render(
      <StrictMode>
        <EncryptionProvider idleTimeoutMs={60_000}>
          <ActionsProbe />
        </EncryptionProvider>
      </StrictMode>,
    );

    const activeWindowListeners = (event: string) =>
      addWindow.mock.calls.filter(([name]) => name === event).length -
      removeWindow.mock.calls.filter(([name]) => name === event).length;
    const activeDocumentListeners = (event: string) =>
      addDocument.mock.calls.filter(([name]) => name === event).length -
      removeDocument.mock.calls.filter(([name]) => name === event).length;

    expect(activeWindowListeners("pointerdown")).toBe(1);
    expect(activeWindowListeners("keydown")).toBe(1);
    expect(activeDocumentListeners("visibilitychange")).toBe(1);

    view.unmount();
    expect(activeWindowListeners("pointerdown")).toBe(0);
    expect(activeWindowListeners("keydown")).toBe(0);
    expect(activeDocumentListeners("visibilitychange")).toBe(0);
  });

  it("clears workspace and Folio visit state when the vault provider tears down", () => {
    clearFolioHistoryState();
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "alpha",
          type: "page",
          path: "notes/alpha.md",
          label: "Alpha",
        },
      ],
      activeTabId: "alpha",
    });
    requestFolioHistoryRestoration({
      tabId: "alpha",
      path: "notes/alpha.md",
      locationId: "visit-alpha",
    });
    const view = render(
      <EncryptionProvider>
        <ActionsProbe />
      </EncryptionProvider>,
    );

    view.unmount();

    expect(useWorkspaceStore.getState().tabs).toEqual([]);
    expect(
      readFolioHistoryRestorationRequest("alpha", "notes/alpha.md"),
    ).toBeNull();
  });
});
