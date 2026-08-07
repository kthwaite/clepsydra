import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("#/api/journal", () => ({
  useQuickCapture: () => ({ mutate: mutateMock, isPending: false }),
}));

import { useUiStore } from "#/store/ui";
import { CaptureAsideModal } from "../CaptureAsideModal";

beforeEach(() => {
  mutateMock.mockReset();
  useUiStore.getState().openCaptureAside();
});

describe("CaptureAsideModal", () => {
  it("submits trimmed content and closes on success", () => {
    mutateMock.mockImplementation((_content, opts) => opts?.onSuccess?.());
    render(<CaptureAsideModal />);
    fireEvent.change(screen.getByLabelText("Aside"), {
      target: { value: "  a thought  " },
    });
    fireEvent.submit(screen.getByLabelText("Aside").closest("form")!);
    expect(mutateMock).toHaveBeenCalledWith("a thought", expect.anything());
    expect(useUiStore.getState().isCaptureAsideOpen).toBe(false);
  });

  it("shows the error inline and stays open on failure", () => {
    mutateMock.mockImplementation((_content, opts) =>
      opts?.onError?.(new Error("Capture failed")),
    );
    render(<CaptureAsideModal />);
    fireEvent.change(screen.getByLabelText("Aside"), {
      target: { value: "x" },
    });
    fireEvent.submit(screen.getByLabelText("Aside").closest("form")!);
    expect(screen.getByText(/Capture failed/)).toBeInTheDocument();
    expect(useUiStore.getState().isCaptureAsideOpen).toBe(true);
  });

  it("renders nothing when closed", () => {
    useUiStore.getState().closeCaptureAside();
    render(<CaptureAsideModal />);
    expect(screen.queryByLabelText("Aside")).toBeNull();
  });
});
