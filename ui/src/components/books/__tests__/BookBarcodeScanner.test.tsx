import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { scannerControls, startScanner } = vi.hoisted(() => ({
  scannerControls: { stop: vi.fn() },
  startScanner: vi.fn(),
}));

vi.mock("#/components/books/book-barcode-scanner", () => ({
  startBookBarcodeScan: startScanner,
}));

import { BookBarcodeScanner } from "#/components/books/BookBarcodeScanner";

function installMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
}

function attachStream() {
  const stopTrack = vi.fn();
  const video = screen.getByTestId("book-barcode-video");
  Object.defineProperty(video, "srcObject", {
    configurable: true,
    value: { getTracks: () => [{ stop: stopTrack }] },
  });
  return stopTrack;
}

describe("BookBarcodeScanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMediaDevices();
    startScanner.mockResolvedValue(scannerControls);
  });

  it("captures a valid book barcode without submitting it", async () => {
    let detect: ((value: string) => void) | undefined;
    startScanner.mockImplementation(async (_video, onDetected) => {
      detect = onDetected;
      return scannerControls;
    });
    const onCapture = vi.fn();
    render(<BookBarcodeScanner onCancel={vi.fn()} onCapture={onCapture} />);
    const stopTrack = attachStream();
    await waitFor(() => expect(startScanner).toHaveBeenCalledOnce());

    act(() => detect?.("978-0-262-01153-2"));

    expect(onCapture).toHaveBeenCalledWith("9780262011532");
    expect(scannerControls.stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("keeps scanning after a non-ISBN barcode", async () => {
    let detect: ((value: string) => void) | undefined;
    startScanner.mockImplementation(async (_video, onDetected) => {
      detect = onDetected;
      return scannerControls;
    });
    const onCapture = vi.fn();
    render(<BookBarcodeScanner onCancel={vi.fn()} onCapture={onCapture} />);
    await waitFor(() => expect(startScanner).toHaveBeenCalledOnce());

    act(() => detect?.("4006381333931"));

    expect(onCapture).not.toHaveBeenCalled();
    expect(scannerControls.stop).not.toHaveBeenCalled();
  });

  it("stops camera resources when cancelled", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<BookBarcodeScanner onCancel={onCancel} onCapture={vi.fn()} />);
    const stopTrack = attachStream();
    await waitFor(() => expect(startScanner).toHaveBeenCalledOnce());

    await user.click(screen.getByRole("button", { name: "Cancel scanning" }));

    expect(scannerControls.stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("explains camera permission denial", async () => {
    const error = new Error("Permission denied");
    error.name = "NotAllowedError";
    startScanner.mockRejectedValue(error);

    render(<BookBarcodeScanner onCancel={vi.fn()} onCapture={vi.fn()} />);

    expect(
      await screen.findByText(/Camera permission was denied/),
    ).toBeInTheDocument();
  });

  it("keeps manual entry available when camera APIs are absent", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    render(<BookBarcodeScanner onCancel={vi.fn()} onCapture={vi.fn()} />);

    expect(
      await screen.findByText(/Camera scanning is not available/),
    ).toBeInTheDocument();
    expect(startScanner).not.toHaveBeenCalled();
  });

  it("stops camera resources on unmount", async () => {
    const view = render(
      <BookBarcodeScanner onCancel={vi.fn()} onCapture={vi.fn()} />,
    );
    const stopTrack = attachStream();
    await waitFor(() => expect(startScanner).toHaveBeenCalledOnce());

    view.unmount();

    expect(scannerControls.stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
