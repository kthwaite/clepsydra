import { vi } from "vitest";

vi.mock("#/components/codex/FolioProperties", () => ({
  FolioProperties: () => (
    <section data-testid="folio-properties">Projected properties</section>
  ),
}));
