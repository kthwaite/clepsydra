import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";

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
        <Outlet />
      </main>
    );
  },
});
