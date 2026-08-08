import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense } from "react";
import { CodexFrame } from "#/components/codex/CodexFrame";
import { ReadingProgressProvider } from "#/components/codex/ReadingProgressContext";
import { RouteError } from "#/components/RouteError";
import { Toaster } from "#/components/ui/Toaster";
import { GlobalShortcuts } from "#/hooks/useGlobalShortcuts";
import { usePreviewStore } from "#/store/preview";
import { useUiStore } from "#/store/ui";

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
const LinkPreviewLayer = lazy(() =>
  import("#/components/codex/LinkPreviewLayer").then((module) => ({
    default: module.LinkPreviewLayer,
  })),
);

export function GlobalOverlays() {
  const searchOpen = useUiStore((state) => state.isSearchOpen);
  const settingsOpen = useUiStore((state) => state.isSettingsOpen);
  const inscribeOpen = useUiStore((state) => state.isInscribeOpen);
  const captureOpen = useUiStore((state) => state.isCaptureAsideOpen);
  const locationOpen = useUiStore((state) => state.isLocationOpen);
  const shortcutHelpOpen = useUiStore((state) => state.isShortcutHelpOpen);
  const booting = useUiStore((state) => state.isBooting);
  const hasPreviews = usePreviewStore((state) => state.windows.length > 0);

  return (
    <>
      {searchOpen && <OverlayBoundary><CommandPalette /></OverlayBoundary>}
      {settingsOpen && <OverlayBoundary><SettingsModal /></OverlayBoundary>}
      {inscribeOpen && <OverlayBoundary><InscribeModal /></OverlayBoundary>}
      {captureOpen && <OverlayBoundary><CaptureAsideModal /></OverlayBoundary>}
      {locationOpen && <OverlayBoundary><LocationModal /></OverlayBoundary>}
      {shortcutHelpOpen && <OverlayBoundary><ShortcutHelpModal /></OverlayBoundary>}
      {hasPreviews && <OverlayBoundary><LinkPreviewLayer /></OverlayBoundary>}
      {booting && <OverlayBoundary><BootSequence /></OverlayBoundary>}
    </>
  );
}

function OverlayBoundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export const Route = createRootRoute({
  notFoundComponent: () => (
    <div className="cl-cap p-8 text-[var(--ink-mute)]">404 · folio missing</div>
  ),
  errorComponent: RouteError,
  head: () => ({
    meta: [{ title: "clepsydra" }],
  }),
  component: () => (
    <>
      <HeadContent />
      <ReadingProgressProvider>
        <CodexFrame>
          <Outlet />
        </CodexFrame>
        <GlobalShortcuts />
        <GlobalOverlays />
        <Toaster />
      </ReadingProgressProvider>
    </>
  ),
});
