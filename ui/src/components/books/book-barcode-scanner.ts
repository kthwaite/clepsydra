export interface BookBarcodeScannerControls {
  stop: () => void;
}

export async function startBookBarcodeScan(
  video: HTMLVideoElement,
  onDetected: (value: string) => void,
): Promise<BookBarcodeScannerControls> {
  const { BrowserMultiFormatOneDReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatOneDReader();

  return reader.decodeFromConstraints(
    {
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    },
    video,
    (result) => {
      if (result) onDetected(result.getText());
    },
  );
}
