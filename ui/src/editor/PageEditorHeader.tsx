import { TagInput } from "#/components/ui/tag-input";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
  /** Flush a save immediately — wired to title/tag blur. */
  onSaveNow?: () => void;
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
  onTagsChange,
  aliases,
  onAliasesChange,
  onSaveNow,
}: PageEditorHeaderProps) {
  return (
    <div className="pb-4">
      <input
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        onBlur={onSaveNow}
        placeholder={filename(path)}
        className="w-full bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground"
      />

      <TagInput
        label="Tags"
        values={tags}
        onChange={onTagsChange}
        onBlur={onSaveNow}
        placeholder="Add tag..."
        className="mt-2"
      />

      {(aliases.length > 0 || tags.length > 0) && (
        <TagInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          onBlur={onSaveNow}
          placeholder="Add alias..."
          className="mt-2"
        />
      )}
    </div>
  );
}
