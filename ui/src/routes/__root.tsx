import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { ThemeToggle } from "#/components/ThemeToggle";

export const Route = createRootRoute({
  notFoundComponent: () => <div>404 - Not Found</div>,
  head: () => ({
    meta: [
      {
        title: "clepsydra",
      },
    ],
  }),
  component: () => {
    return (
      <main className="h-screen font-sans text-foreground">
        <HeadContent />
        <header className="flex items-center justify-end p-3">
          <ThemeToggle className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-foreground" />
        </header>
        <Outlet />
      </main>
    );
  },
});
