import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_DOC_SLUG } from "#/docs/registry";

// Remove the temporary route boundaries after the controller regenerates
// routeTree.gen.ts with the Task 7 file routes.
export const Route = createFileRoute("/docs")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$slug" as never,
      params: { slug: DEFAULT_DOC_SLUG } as never,
    });
  },
});
