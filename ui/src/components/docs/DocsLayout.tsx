import { Menu, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { DocsSidebar } from "#/components/docs/DocsSidebar";
import { IconButton } from "#/components/ui/icon-button";

export interface DocsLayoutProps {
  activeSlug?: string;
  children: ReactNode;
}

export function DocsLayout({ activeSlug, children }: DocsLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-paper text-ink">
      <aside
        data-testid="docs-desktop-rail"
        className="hidden w-72 shrink-0 flex-col overflow-y-auto border-r border-rule bg-paper-2 md:flex"
      >
        <DocsSidebar activeSlug={activeSlug} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-rule bg-paper-2 px-3 md:hidden">
          <IconButton
            variant="secondary"
            aria-label="Open documentation navigation"
            onPress={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </IconButton>
          <span className="ml-3 font-mono text-xs font-semibold uppercase tracking-widest text-ink-2">
            Documentation
          </span>
        </header>

        <main
          aria-label="Documentation article"
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>

      <ModalOverlay
        isOpen={drawerOpen}
        isDismissable
        onOpenChange={setDrawerOpen}
        className="fixed inset-0 z-50 flex justify-start bg-foreground/30 pr-12 md:hidden"
      >
        <Modal className="h-full w-full max-w-xs bg-paper-2 shadow-lg">
          <Dialog
            aria-label="Documentation navigation"
            className="flex h-full min-h-0 flex-col outline-none"
          >
            {({ close }) => (
              <>
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-rule px-3">
                  <Heading
                    slot="title"
                    className="font-mono text-xs font-semibold uppercase tracking-widest text-ink-2"
                  >
                    Documentation navigation
                  </Heading>
                  <IconButton
                    variant="ghost"
                    aria-label="Close documentation navigation"
                    onPress={close}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </div>
                <DocsSidebar activeSlug={activeSlug} onNavigate={close} />
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
