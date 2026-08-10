import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeIsbn } from "#/lib/isbn";
import {
  type BookBarcodeScannerControls,
  startBookBarcodeScan,
} from "./book-barcode-scanner";

interface BookBarcodeScannerProps {
  onCapture: (isbn: string) => void;
  onCancel: () => void;
}

export function BookBarcodeScanner({
  onCapture,
  onCancel,
}: BookBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<BookBarcodeScannerControls | null>(null);
  const onCaptureRef = useRef(onCapture);
  const [message, setMessage] = useState("Starting camera…");
  const [isError, setIsError] = useState(false);
  onCaptureRef.current = onCapture;

  const stop = useCallback((video = videoRef.current) => {
    controlsRef.current?.stop();
    controlsRef.current = null;

    const stream = video?.srcObject;
    if (stream && "getTracks" in stream) {
      for (const track of stream.getTracks()) track.stop();
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const video = videoRef.current;

    if (!navigator.mediaDevices?.getUserMedia || !video) {
      setIsError(true);
      setMessage(
        "Camera scanning is not available here. Enter the ISBN manually.",
      );
      return stop;
    }

    startBookBarcodeScan(video, (rawValue) => {
      const normalized = normalizeIsbn(rawValue);
      if (!normalized || disposed) return;
      stop(video);
      onCaptureRef.current(normalized);
    })
      .then((controls) => {
        if (disposed) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setMessage("Point the camera at the barcode on the back of the book.");
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setIsError(true);
        setMessage(cameraErrorMessage(cause));
        stop(video);
      });

    return () => {
      disposed = true;
      stop(video);
    };
  }, [stop]);

  return (
    <div className="mt-3 border border-rule bg-paper-2 p-2">
      <video
        aria-label="Book barcode camera preview"
        autoPlay
        className="aspect-[4/3] w-full bg-ink object-cover"
        data-testid="book-barcode-video"
        muted
        playsInline
        ref={videoRef}
      />
      <p
        aria-live="polite"
        className={
          isError
            ? "cl-mono mt-2 text-[10px] text-hot"
            : "cl-mono mt-2 text-[10px] text-ink-mute"
        }
      >
        {message}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="cl-btn"
          onClick={() => {
            stop();
            onCancel();
          }}
          type="button"
        >
          Cancel scanning
        </button>
      </div>
    </div>
  );
}

function cameraErrorMessage(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "NotAllowedError"
  ) {
    return "Camera permission was denied. Allow access or enter the ISBN manually.";
  }
  return "The camera could not be started. Enter the ISBN manually.";
}
