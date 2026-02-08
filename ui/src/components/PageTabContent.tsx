import { useEffect } from "react";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { BacklinksPanel } from "#/components/BacklinksPanel";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { PageHeader } from "#/components/PageHeader";
import { useWorkspaceStore } from "#/store/workspace";

interface PageTabContentProps {
  tabId: string;
  path: string;
}

export function PageTabContent({ tabId, path }: PageTabContentProps) {
  const { data: page, isLoading, error } = usePage(path);
  const { data: backlinks } = useBacklinks(path);
  const updateTabLabel = useWorkspaceStore((s) => s.updateTabLabel);

  useEffect(() => {
    if (page?.meta.title) {
      updateTabLabel(tabId, page.meta.title);
    }
  }, [tabId, page?.meta.title, updateTabLabel]);

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading...</div>;
  }
  if (error || !page) {
    return <div className="p-8 text-destructive">Page not found</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <PageHeader title={page.meta.title} path={page.path} meta={page.meta} />
      <article className="mt-6">
        <MarkdownRenderer content={page.body} />
      </article>
      {backlinks && backlinks.length > 0 && (
        <BacklinksPanel backlinks={backlinks} />
      )}
    </div>
  );
}
