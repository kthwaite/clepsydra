import { Menu, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Tick } from "#/components/codex/Tick";
import { DocsSidebar } from "#/components/docs/DocsSidebar";
import { DocsToc } from "#/components/docs/DocsToc";
import { IconButton } from "#/components/ui/icon-button";
import type { DocTocEntry } from "#/docs/toc";

const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";

export interface DocsLayoutProps {
  activeSlug?: string;
  toc?: readonly DocTocEntry[];
  children: ReactNode;
}

export function DocsLayout({ activeSlug, toc, children }: DocsLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasToc = toc !== undefined && toc.length > 0;

  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_MEDIA_QUERY);
    if (!media) return;
    const closeForDesktop = (event: MediaQueryListEvent) => {
      if (!event.matches || !drawerOpen) return;
      setDrawerOpen(false);
      window.setTimeout(() => {
        articleRef.current?.focus({ preventScroll: true });
      });
    };

    media.addEventListener("change", closeForDesktop);
    return () => media.removeEventListener("change", closeForDesktop);
  }, [drawerOpen]);

  return (
    <div
      data-testid="docs-layout"
      className="flex h-full min-h-0 overflow-hidden bg-ground text-ink md:gap-8 md:px-6 md:pt-6 lg:gap-14 lg:px-10"
    >
      <aside
        data-testid="docs-desktop-rail"
        className="hidden w-60 shrink-0 flex-col overflow-y-auto rounded-t-2xl bg-sink md:flex lg:w-72"
      >
        <DocsSidebar activeSlug={activeSlug} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 px-3 md:hidden">
          <IconButton
            variant="secondary"
            aria-label="Open documentation navigation"
            onPress={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </IconButton>
          <span className="font-serif text-[18px] italic leading-none text-mute">
            Documentation
          </span>
        </header>

        <main
          ref={articleRef}
          aria-label="Documentation article"
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {children}
        </main>
      </div>

      {hasToc ? (
        <aside
          data-testid="docs-toc-rail"
          className="hidden w-58 shrink-0 flex-col overflow-y-auto pb-6 pt-6 xl:flex"
        >
          <DocsToc
            entries={toc}
            containerRef={articleRef}
            recount={activeSlug}
          />
        </aside>
      ) : null}

      <ModalOverlay
        data-testid="docs-drawer-overlay"
        isOpen={drawerOpen}
        isDismissable
        onOpenChange={setDrawerOpen}
        className="fixed inset-0 z-50 flex justify-start bg-scrim pr-12 md:hidden"
      >
        <Modal className="h-full w-full max-w-xs rounded-r-[18px] bg-sink shadow-lg">
          <Dialog
            aria-label="Documentation navigation"
            className="flex h-full min-h-0 flex-col outline-none"
          >
            {({ close }) => (
              <>
                <div className="flex h-14 shrink-0 items-center justify-between gap-3 pl-4 pr-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Tick />
                    <Heading
                      slot="title"
                      className="truncate font-serif text-[18px] font-normal italic leading-none text-mute"
                    >
                      Documentation navigation
                    </Heading>
                  </div>
                  <IconButton
                    variant="ghost"
                    aria-label="Close documentation navigation"
                    onPress={close}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </div>
                <DocsSidebar activeSlug={activeSlug} onNavigate={close} />
                {hasToc ? (
                  <DocsToc
                    entries={toc}
                    containerRef={articleRef}
                    recount={activeSlug}
                    onNavigate={close}
                    className="max-h-64 shrink-0 px-4 pb-4 pt-3"
                  />
                ) : null}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
