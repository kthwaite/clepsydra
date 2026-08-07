import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { BootSequence } from "#/components/codex/BootSequence";
import { CaptureAsideModal } from "#/components/codex/CaptureAsideModal";
import { CodexFrame } from "#/components/codex/CodexFrame";
import { CommandPalette } from "#/components/codex/CommandPalette";
import { InscribeModal } from "#/components/codex/InscribeModal";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { LocationModal } from "#/components/codex/LocationModal";
import { ReadingProgressProvider } from "#/components/codex/ReadingProgressContext";
import { ShortcutHelpModal } from "#/components/codex/ShortcutHelpModal";
import { RouteError } from "#/components/RouteError";
import { SettingsModal } from "#/components/SettingsModal";
import { Toaster } from "#/components/ui/Toaster";
import { GlobalShortcuts } from "#/hooks/useGlobalShortcuts";

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
        <CommandPalette />
        <SettingsModal />
        <InscribeModal />
        <CaptureAsideModal />
        <LocationModal />
        <ShortcutHelpModal />
        <LinkPreviewLayer />
        <BootSequence />
        <Toaster />
      </ReadingProgressProvider>
    </>
  ),
});
