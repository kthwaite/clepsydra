import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_DOC_SLUG } from "#/docs/registry";

export const Route = createFileRoute("/docs")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/docs" || location.pathname === "/docs/") {
      throw redirect({
        to: "/docs/$slug",
        params: { slug: DEFAULT_DOC_SLUG },
        hash: location.hash || undefined,
      });
    }
  },
});
