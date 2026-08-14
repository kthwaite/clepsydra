import { createFileRoute } from "@tanstack/react-router";
import { RubbishBin } from "#/components/rubbish/RubbishBin";

export const Route = createFileRoute("/rubbish")({
  staticData: { codexView: "rubbish" },
  component: RubbishBin,
});
