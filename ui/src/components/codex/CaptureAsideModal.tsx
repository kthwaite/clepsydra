import { type FormEvent, useState } from "react";
import { useQuickCapture } from "#/api/journal";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { useUiStore } from "#/store/ui";

/** One-line aside capture — appends a time-stamped entry to today's journal
 *  from anywhere (⌘⇧D / palette). The server stamps plain prose and creates
 *  the journal if it does not exist yet. */
export function CaptureAsideModal() {
  const isOpen = useUiStore((s) => s.isCaptureAsideOpen);
  const onClose = useUiStore((s) => s.closeCaptureAside);
  const capture = useQuickCapture();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const dismiss = () => {
    setText("");
    setError(null);
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    setError(null);
    capture.mutate(content, {
      onSuccess: dismiss,
      onError: (err) => setError(err.message),
    });
  };

  return (
    <CodexModalShell
      ariaLabel="Capture aside"
      maxWidthClassName="max-w-[480px]"
      panelClassName="rounded-[18px]"
      onDismiss={dismiss}
    >
      <form
        onSubmit={submit}
        className="flex flex-col gap-[22px] px-6 py-7 md:px-9 md:py-8"
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="font-serif text-[34px] font-normal leading-[1.05] text-ink">
            Aside
          </h2>
          <span className="text-[13px] text-mute">Today's journal</span>
        </div>
        <input
          aria-label="Aside"
          value={text}
          onChange={(e) => setText(e.target.value)}
          // biome-ignore lint/a11y/noAutofocus: this single-field capture modal intentionally starts focus at its only text input
          autoFocus
          placeholder="Capture an aside…"
          className={cn(
            "h-11 w-full shrink-0 rounded-[10px] bg-sink px-3.5 text-[15px] text-ink placeholder:text-mute",
            FOCUS_RING_NATIVE,
          )}
        />
        {error && <div className="text-[13.5px] text-hot">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onPress={dismiss}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={capture.isPending || !text.trim()}
          >
            {capture.isPending ? "Noting…" : "Note"}
          </Button>
        </div>
      </form>
    </CodexModalShell>
  );
}
