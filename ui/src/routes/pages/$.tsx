import { createFileRoute } from "@tanstack/react-router";
import { usePage } from "#/api/pages";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { PageHeader } from "#/components/PageHeader";

export const Route = createFileRoute("/pages/$")({
  component: PageViewer,
});

function PageViewer() {
  const { _splat: path } = Route.useParams();
  const { data: page, isLoading, error } = usePage(path ?? "");

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
    </div>
  );
}
