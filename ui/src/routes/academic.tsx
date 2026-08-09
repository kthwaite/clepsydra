import { createFileRoute } from "@tanstack/react-router";
import { AcademicLibrary } from "#/components/academic/AcademicLibrary";

export const Route = createFileRoute("/academic")({
  component: AcademicLibrary,
});
