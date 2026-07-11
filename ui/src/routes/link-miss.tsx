import { createFileRoute } from "@tanstack/react-router";

type LinkMissSearch = { target?: string };

export const Route = createFileRoute("/link-miss")({
  validateSearch: (search: Record<string, unknown>): LinkMissSearch => ({
    target: typeof search.target === "string" ? search.target : undefined,
  }),
  component: LinkMissPage,
});

function LinkMissPage() {
  const { target } = Route.useSearch();
  return <LinkMissView target={target} />;
}

export function LinkMissView({ target }: { target?: string }) {
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-4 p-8">
      <div className="cl-mono text-xs tracking-widest text-muted-foreground">
        DEEP LINK
      </div>
      <h1 className="text-xl font-semibold">No page matches this link</h1>
      {target && (
        <code className="cl-mono max-w-full truncate border border-border bg-muted px-2 py-1 text-sm">
          {target}
        </code>
      )}
      <a
        href="/workspace"
        className="underline decoration-1 underline-offset-2 hover:decoration-2"
      >
        Open workspace
      </a>
    </div>
  );
}
