import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";

const {
  baseProjectionState,
  pageState,
  previewBodyMock,
  toastErrorMock,
  usePageBasePropertiesMock,
} = vi.hoisted(() => ({
  baseProjectionState: {
    data: undefined as
      | { preview: { fields: unknown[]; remaining_count: number } }
      | undefined,
    isPending: true,
    isError: false,
  },
  pageState: {
    data: undefined as
      | {
          meta: { id: string; title: string };
          body: string;
          encrypted?: boolean;
        }
      | undefined,
  },
  previewBodyMock: vi.fn(),
  toastErrorMock: vi.fn(),
  usePageBasePropertiesMock: vi.fn(),
}));

vi.mock("#/api/bases", () => ({
  usePageBaseProperties: (uuid: string) => {
    usePageBasePropertiesMock(uuid);
    return baseProjectionState;
  },
}));
vi.mock("#/api/index", () => ({ useBacklinks: () => ({ data: [] }) }));
vi.mock("#/api/pages", () => ({ usePage: () => pageState }));
vi.mock("#/components/codex/PreviewBody", () => ({
  PreviewBody: (props: unknown) => {
    previewBodyMock(props);
    return null;
  },
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

const rect = new DOMRect(24, 10, 120, 28);

beforeEach(() => {
  pageState.data = undefined;
  baseProjectionState.data = undefined;
  baseProjectionState.isPending = true;
  baseProjectionState.isError = false;
  previewBodyMock.mockReset();
  toastErrorMock.mockReset();
  usePageBasePropertiesMock.mockReset();
});

it("waits for page identity and forwards success, pending, and error states", () => {
  const view = render(<TabPreviewCard path="notes/target.md" rect={rect} />);

  expect(usePageBasePropertiesMock).toHaveBeenLastCalledWith("");
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preview: undefined,
      previewPending: true,
      previewError: false,
      showTags: false,
    }),
  );

  pageState.data = {
    meta: { id: "page-target", title: "Target" },
    body: "",
  };
  baseProjectionState.data = {
    preview: { fields: [], remaining_count: 0 },
  };
  baseProjectionState.isPending = false;
  view.rerender(<TabPreviewCard path="notes/target.md" rect={rect} />);

  expect(usePageBasePropertiesMock).toHaveBeenLastCalledWith("page-target");
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preview: baseProjectionState.data.preview,
      previewPending: false,
      previewError: false,
    }),
  );

  baseProjectionState.data = undefined;
  baseProjectionState.isError = true;
  view.rerender(<TabPreviewCard path="notes/target.md" rect={rect} />);
  expect(previewBodyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ previewError: true }),
  );
  expect(toastErrorMock).not.toHaveBeenCalled();
});

it("remains a passive pointer-transparent card", () => {
  render(<TabPreviewCard path="notes/target.md" rect={rect} />);

  expect(document.querySelector(".pointer-events-none")).not.toBeNull();
});
