import { TagInput } from "#/components/ui/tag-input";

interface PageEditorHeaderProps {
  path: string;
  title: string;
  onTitleChange: (title: string) => void;
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  aliases: string[];
  onAliasesChange: (aliases: string[]) => void;
}

export function PageEditorHeader({
  path,
  title,
  onTitleChange,
  tags,
  onTagsChange,
  aliases,
  onAliasesChange,
}: PageEditorHeaderProps) {
  return (
    <div className="border-b border-border pb-4">
      <input
        type="text"
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Untitled"
        className="w-full bg-transparent font-heading text-2xl font-bold outline-none placeholder:text-muted-foreground"
      />

      <p className="mt-1 text-sm text-muted-foreground">{path}</p>

      <TagInput
        label="Tags"
        values={tags}
        onChange={onTagsChange}
        placeholder="Add tag..."
        className="mt-2"
      />

      {(aliases.length > 0 || tags.length > 0) && (
        <TagInput
          label="Aliases"
          values={aliases}
          onChange={onAliasesChange}
          placeholder="Add alias..."
          className="mt-2"
        />
      )}
    </div>
  );
}
