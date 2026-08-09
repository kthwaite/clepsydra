import { beforeEach, describe, expect, it, vi } from "vitest";

const { controls, decodeFromConstraints, readerConstructor } = vi.hoisted(
  () => {
    const controls = { stop: vi.fn() };
    const decodeFromConstraints = vi.fn().mockResolvedValue(controls);
    const readerConstructor = vi.fn(function MockReader() {
      return { decodeFromConstraints };
    });
    return { controls, decodeFromConstraints, readerConstructor };
  },
);

vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatOneDReader: readerConstructor,
}));

import { startBookBarcodeScan } from "./book-barcode-scanner";

describe("startBookBarcodeScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decodeFromConstraints.mockResolvedValue(controls);
  });

  it("starts a rear-camera one-dimensional scan", async () => {
    const video = document.createElement("video");
    const onDetected = vi.fn();

    const result = await startBookBarcodeScan(video, onDetected);

    expect(readerConstructor).toHaveBeenCalledOnce();
    expect(decodeFromConstraints).toHaveBeenCalledWith(
      {
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      },
      video,
      expect.any(Function),
    );
    expect(result).toBe(controls);
  });

  it("forwards decoded text and ignores decode misses", async () => {
    const onDetected = vi.fn();
    await startBookBarcodeScan(document.createElement("video"), onDetected);
    const callback = decodeFromConstraints.mock.calls[0]?.[2];

    callback?.(undefined, new Error("no barcode in this frame"));
    expect(onDetected).not.toHaveBeenCalled();

    callback?.({ getText: () => "9780262011532" }, undefined);
    expect(onDetected).toHaveBeenCalledWith("9780262011532");
  });
});
