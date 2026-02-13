import { useEffect } from "react";
import { useBacklinks } from "#/api/index";
import { BacklinksPanel } from "#/components/BacklinksPanel";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";
import { useWorkspaceStore } from "#/store/workspace";

interface PageTabContentProps {
  tabId: string;
  path: string;
}

export function PageTabContent({ tabId, path }: PageTabContentProps) {
  const editor = usePageEditor(path);
  const { data: backlinks } = useBacklinks(path);
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);

  useEffect(() => {
    if (editor.title) {
      updateTabLabel(tabId, editor.title);
    }
  }, [tabId, editor.title, updateTabLabel]);

  if (editor.isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }
  if (editor.error) {
    return <div className="p-8 text-destructive">Page not found</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <div className="mb-2 flex items-center justify-end">
        <SaveIndicator status={editor.saveStatus} error={editor.saveError} />
      </div>

      <PageEditorHeader
        path={path}
        title={editor.title}
        onTitleChange={editor.setTitle}
        tags={editor.tags}
        onTagsChange={editor.setTags}
        aliases={editor.aliases}
        onAliasesChange={editor.setAliases}
      />

      <article className="mt-6">
        <SlateEditor
          initialValue={editor.initialValue}
          onChange={editor.onSlateChange}
          onSaveNow={editor.saveNow}
        />
      </article>

      {backlinks && backlinks.length > 0 && (
        <BacklinksPanel backlinks={backlinks} />
      )}
    </div>
  );
}
