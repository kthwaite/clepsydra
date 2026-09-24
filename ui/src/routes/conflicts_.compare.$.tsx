import { createFileRoute, notFound } from "@tanstack/react-router";
import { ConflictDiffView } from "#/components/conflicts/ConflictDiffView";

// `conflicts_` opts out of nesting: `/conflicts` renders no <Outlet />, so the
// compare view is a sibling page rather than a child of the list. The
// `compare` segment keeps the splat from also matching a bare `/conflicts`
// (a splat accepts an empty remainder and would outrank the list).
export const Route = createFileRoute("/conflicts_/compare/$")({
  staticData: { codexView: "conflicts" },
  component: ConflictComparePage,
});

function ConflictComparePage() {
  const { _splat: copyPath } = Route.useParams();
  if (!copyPath) throw notFound();
  return <ConflictDiffView key={copyPath} copyPath={copyPath} />;
}
