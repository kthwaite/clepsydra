import { useState } from "react";
import { TagInput } from "#/components/ui/tag-input";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  derivedTags?: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
  /** Flush a save immediately — wired to title/tag blur. */
  onSaveNow?: () => void | Promise<void>;
  /** When set, the title renders as this static text and cannot be edited
   *  (JOURNAL pages: the formatted day label). */
  readOnlyTitle?: string;
  encrypted?: boolean;
  onRequestLock?: () => Promise<boolean>;
}

/** Last path segment, e.g. "notes/ideas/my-note.md" → "my-note.md". */
function filename(path: string): string {
  return path.split("/").pop() || path;
}

export function PageEditorHeader({
  path,
  title,
  onTitleChange,
  tags,
  derivedTags = [],
  onTagsChange,
  aliases,
  onAliasesChange,
  onSaveNow,
  readOnlyTitle,
  encrypted = false,
  onRequestLock,
}: PageEditorHeaderProps) {
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  const requestLock = async () => {
    if (!onRequestLock || locking) return;
    setLocking(true);
    setLockError(null);
    try {
      const locked = await onRequestLock();
      if (!locked) {
        setLockError("Unable to lock while an editor has unsaved changes.");
      }
    } catch {
      setLockError("Unable to lock while an editor has unsaved changes.");
    } finally {
      setLocking(false);
    }
  };
  const flush = () => {
    void Promise.resolve(onSaveNow?.()).catch(() => undefined);
  };

  return (
    <div className="pb-4">
      {encrypted && onRequestLock ? (
        <div className="mb-2 flex items-center justify-end gap-2">
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            encrypted
          </span>
          <button
            type="button"
            className="cl-btn"
            disabled={locking}
            onClick={() => void requestLock()}
            aria-label="Lock encrypted notes"
          >
            {locking ? "locking…" : "lock"}
          </button>
        </div>
      ) : null}
      {lockError ? (
        <p role="alert" className="cl-mono mb-2 text-[10px] text-hot">
          ⁂ {lockError}
        </p>
      ) : null}
      {readOnlyTitle !== undefined ? (
        <h1 className="w-full font-heading text-2xl font-bold">
          {readOnlyTitle}
        </h1>
      ) : (
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={flush}
          placeholder={filename(path)}
          className="w-full bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground"
        />
      )}

      <TagInput
        label="Tags"
        values={tags}
        readOnlyValues={derivedTags}
        onChange={onTagsChange}
        onBlur={flush}
        placeholder="Add tag..."
        className="mt-2"
      />

      {(aliases.length > 0 || tags.length > 0) && (
        <TagInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          onBlur={flush}
          placeholder="Add alias..."
          className="mt-2"
        />
      )}
    </div>
  );
}
