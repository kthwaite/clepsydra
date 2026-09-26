import { createFileRoute } from "@tanstack/react-router";
import { Atrium } from "#/components/codex/Atrium";
import { MobileToday } from "#/components/mobile/MobileToday";
import { useMobileLayout } from "#/hooks/useMobileLayout";

function Home() {
  return useMobileLayout() ? <MobileToday /> : <Atrium />;
}

export const Route = createFileRoute("/")({
  staticData: { codexView: "atrium" },
  component: Home,
});
