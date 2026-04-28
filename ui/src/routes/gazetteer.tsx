import { createFileRoute } from "@tanstack/react-router";
import { Gazetteer } from "#/components/codex/Gazetteer";

type GazetteerSearch = {
  tag?: string;
};

export const Route = createFileRoute("/gazetteer")({
  validateSearch: (search: Record<string, unknown>): GazetteerSearch => ({
    tag: typeof search.tag === "string" ? search.tag : undefined,
  }),
  component: GazetteerPage,
});

function GazetteerPage() {
  const { tag } = Route.useSearch();
  return <Gazetteer initialTag={tag} />;
}
