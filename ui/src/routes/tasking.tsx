import { createFileRoute } from "@tanstack/react-router";
import { TaskingScreen } from "#/components/tasking/TaskingScreen";

export const Route = createFileRoute("/tasking")({
  component: TaskingScreen,
});
