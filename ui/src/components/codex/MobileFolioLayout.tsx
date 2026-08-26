import { type ReactNode, useState } from "react";
import {
  Button,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";

export interface MobileFolioLayoutProps {
  header: ReactNode;
  document: ReactNode;
  details: ReactNode;
  relationships: ReactNode;
  contents: ReactNode;
  onBack: () => void;
}

type MobileSheet = "details" | "relationships";

const disclosureButtonClass =
  "cl-mono inline-flex min-h-11 items-center justify-center px-3 text-[10px] uppercase tracking-[0.12em] text-ink-2 outline-none hover:bg-highlight focus-visible:ring-2 focus-visible:ring-accent";

export function MobileFolioLayout({
  header,
  document,
  details,
  relationships,
  contents,
  onBack,
}: MobileFolioLayoutProps) {
  const [sheet, setSheet] = useState<MobileSheet | null>(null);
  const title = sheet === "details" ? "Document details" : "Page relationships";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-paper [&_button]:min-h-11 [&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11">
      <nav
        aria-label="Page controls"
        className="flex min-h-11 shrink-0 items-stretch border-b border-rule"
      >
        <Button className={disclosureButtonClass} onPress={onBack}>
          Back
        </Button>
        <span className="min-w-0 flex-1" />
        <Button
          className={disclosureButtonClass}
          onPress={() => setSheet("details")}
        >
          Document details
        </Button>
        <Button
          className={disclosureButtonClass}
          onPress={() => setSheet("relationships")}
        >
          Page relationships
        </Button>
      </nav>

      <main
        aria-label="Page document"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <div className="shrink-0 px-4 pt-3">{header}</div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{document}</div>
      </main>

      <ModalOverlay
        isOpen={sheet !== null}
        isDismissable
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        className="fixed inset-0 z-50 flex justify-end bg-foreground/30"
      >
        <Modal className="h-dvh w-full max-w-md bg-paper-2 shadow-lg outline-none">
          <Dialog
            aria-label={title}
            className="flex h-full min-h-0 flex-col outline-none [&_button]:min-h-11 [&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11 [&_[role=option]]:min-h-11"
          >
            <div className="flex min-h-11 shrink-0 items-stretch border-b border-rule pl-4">
              <Heading
                slot="title"
                className="cl-mono flex min-w-0 flex-1 items-center text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-2"
              >
                {title}
              </Heading>
              {sheet === "details" ? (
                <Button
                  className={disclosureButtonClass}
                  onPress={() => setSheet("relationships")}
                >
                  Page relationships
                </Button>
              ) : (
                <Button
                  className={disclosureButtonClass}
                  onPress={() => setSheet("details")}
                >
                  Document details
                </Button>
              )}
              <Button
                aria-label={`Close ${title.toLowerCase()}`}
                className={disclosureButtonClass}
                onPress={() => setSheet(null)}
              >
                Close
              </Button>
            </div>
            <div className="cl-noscroll min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {sheet === "details" ? (
                <>
                  <div className="py-3">{details}</div>
                  <div className="border-t border-rule py-3">{contents}</div>
                </>
              ) : (
                <div className="py-3">{relationships}</div>
              )}
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}
