import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { CodexFrame } from "#/components/codex/CodexFrame";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { ReadingProgressProvider } from "#/components/codex/ReadingProgressContext";
import { FeatureFlagsProvider } from "#/components/FeatureFlagsProvider";
import { NotFoundPage } from "#/components/FeatureGate";
import { RouteError } from "#/components/RouteError";
import { Toaster } from "#/components/ui/Toaster";
import { GlobalShortcuts } from "#/hooks/useGlobalShortcuts";
import { usePreviewStore } from "#/store/preview";
import { useUiStore } from "#/store/ui";

export { NotFoundPage };

const CommandPalette = lazy(() =>
  import("#/components/codex/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const SettingsModal = lazy(() =>
  import("#/components/SettingsModal").then((module) => ({
    default: module.SettingsModal,
  })),
);
const InscribeModal = lazy(() =>
  import("#/components/codex/InscribeModal").then((module) => ({
    default: module.InscribeModal,
  })),
);
const CaptureAsideModal = lazy(() =>
  import("#/components/codex/CaptureAsideModal").then((module) => ({
    default: module.CaptureAsideModal,
  })),
);
const BookImportModal = lazy(() =>
  import("#/components/books/BookImportModal").then((module) => ({
    default: module.BookImportModal,
  })),
);
const LocationModal = lazy(() =>
  import("#/components/codex/LocationModal").then((module) => ({
    default: module.LocationModal,
  })),
);
const ShortcutHelpModal = lazy(() =>
  import("#/components/codex/ShortcutHelpModal").then((module) => ({
    default: module.ShortcutHelpModal,
  })),
);
const BootSequence = lazy(() =>
  import("#/components/codex/BootSequence").then((module) => ({
    default: module.BootSequence,
  })),
);

export function GlobalOverlays() {
  const searchOpen = useUiStore((state) => state.isSearchOpen);
  const settingsOpen = useUiStore((state) => state.isSettingsOpen);
  const inscribeOpen = useUiStore((state) => state.isInscribeOpen);
  const captureOpen = useUiStore((state) => state.isCaptureAsideOpen);
  const bookImportOpen = useUiStore((state) => state.isBookImportOpen);
  const locationOpen = useUiStore((state) => state.isLocationOpen);
  const shortcutHelpOpen = useUiStore((state) => state.isShortcutHelpOpen);
  const booting = useUiStore((state) => state.isBooting);
  const closeSearch = useUiStore((state) => state.closeSearch);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const closeInscribe = useUiStore((state) => state.closeInscribe);
  const closeCaptureAside = useUiStore((state) => state.closeCaptureAside);
  const closeBookImport = useUiStore((state) => state.closeBookImport);
  const closeLocation = useUiStore((state) => state.closeLocation);
  const closeShortcutHelp = useUiStore((state) => state.closeShortcutHelp);
  const endBoot = useUiStore((state) => state.endBoot);
  const hasPreviews = usePreviewStore((state) => state.windows.length > 0);

  return (
    <>
      {searchOpen && (
        <OverlayBoundary onDismiss={closeSearch} label="Search">
          <CommandPalette />
        </OverlayBoundary>
      )}
      {settingsOpen && (
        <OverlayBoundary onDismiss={closeSettings} label="Settings">
          <SettingsModal />
        </OverlayBoundary>
      )}
      {inscribeOpen && (
        <OverlayBoundary onDismiss={closeInscribe} label="Inscribe">
          <InscribeModal />
        </OverlayBoundary>
      )}
      {captureOpen && (
        <OverlayBoundary onDismiss={closeCaptureAside} label="Capture">
          <CaptureAsideModal />
        </OverlayBoundary>
      )}
      {bookImportOpen && (
        <OverlayBoundary onDismiss={closeBookImport} label="Add book">
          <BookImportModal />
        </OverlayBoundary>
      )}
      {locationOpen && (
        <OverlayBoundary onDismiss={closeLocation} label="Location">
          <LocationModal />
        </OverlayBoundary>
      )}
      {shortcutHelpOpen && (
        <OverlayBoundary onDismiss={closeShortcutHelp} label="Shortcut help">
          <ShortcutHelpModal />
        </OverlayBoundary>
      )}
      {hasPreviews && <LinkPreviewLayer />}
      {booting && (
        <OverlayBoundary onDismiss={endBoot} label="Boot sequence">
          <BootSequence />
        </OverlayBoundary>
      )}
    </>
  );
}

export function OverlayBoundary({
  children,
  onDismiss,
  label,
}: {
  children: ReactNode;
  onDismiss: () => void;
  label: string;
}) {
  return (
    <Suspense
      fallback={<OverlayLoadingFallback onDismiss={onDismiss} label={label} />}
    >
      {children}
    </Suspense>
  );
}

function OverlayLoadingFallback({
  onDismiss,
  label,
}: {
  onDismiss: () => void;
  label: string;
}) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    targetRef.current?.focus();
  }, []);

  return (
    <div
      ref={targetRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Loading ${label}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-paper"
    >
      <span className="cl-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-mute)]">
        Loading {label}…
      </span>
    </div>
  );
}

export const Route = createRootRoute({
  staticData: { codexView: "atrium" },
  notFoundComponent: NotFoundPage,
  errorComponent: RouteError,
  head: () => ({
    meta: [{ title: "clepsydra" }],
  }),
  component: () => (
    <>
      <HeadContent />
      <FeatureFlagsProvider>
        <ReadingProgressProvider>
          <CodexFrame>
            <Outlet />
          </CodexFrame>
          <GlobalShortcuts />
          <GlobalOverlays />
          <Toaster />
        </ReadingProgressProvider>
      </FeatureFlagsProvider>
    </>
  ),
});
