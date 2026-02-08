import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { AppLayout } from "#/components/AppLayout";

export const Route = createRootRoute({
  notFoundComponent: () => <div className="p-8">404 - Not Found</div>,
  head: () => ({
    meta: [{ title: "clepsydra" }],
  }),
  component: () => (
    <>
      <HeadContent />
      <AppLayout>
        <Outlet />
      </AppLayout>
    </>
  ),
});
