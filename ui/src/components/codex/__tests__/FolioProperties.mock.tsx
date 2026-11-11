import type { ReactNode } from "react";
import { vi } from "vitest";

vi.mock("#/components/codex/FolioProperties", () => ({
  FolioProperties: () => (
    <section data-testid="folio-properties">Projected properties</section>
  ),
}));

vi.mock("#/components/attachments/PageAttachmentGallery", () => ({
  PageAttachmentGallery: ({ children }: { children: ReactNode }) => children,
  PageAttachmentSection: () => null,
}));
