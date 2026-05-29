import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { BootSequence } from "#/components/codex/BootSequence";
import { CodexFrame } from "#/components/codex/CodexFrame";
import { CommandPalette } from "#/components/codex/CommandPalette";
import { InscribeModal } from "#/components/codex/InscribeModal";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { ReadingProgressProvider } from "#/components/codex/ReadingProgressContext";
import { RouteError } from "#/components/RouteError";
import { SettingsModal } from "#/components/SettingsModal";

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
        <CommandPalette />
        <SettingsModal />
        <InscribeModal />
        <LinkPreviewLayer />
        <BootSequence />
      </ReadingProgressProvider>
    </>
  ),
});
