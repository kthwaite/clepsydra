import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";
import { AppLayout } from "#/components/AppLayout";
import { RouteError } from "#/components/RouteError";

export const Route = createRootRoute({
  notFoundComponent: () => <div className="p-8">404 - Not Found</div>,
  errorComponent: RouteError,
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
