import { render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));
vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => layout.mobile,
}));
vi.mock("#/components/codex/Atrium", () => ({
  Atrium: () => <p>Atrium screen</p>,
}));
vi.mock("#/components/mobile/MobileToday", () => ({
  MobileToday: () => <p>Mobile Today</p>,
}));

import { Route } from "#/routes/index";

const Home = Route.options.component as ComponentType;

describe("home route", () => {
  it("shows the Atrium on desktop", () => {
    layout.mobile = false;
    render(<Home />);
    expect(screen.getByText("Atrium screen")).toBeVisible();
  });

  it("shows mobile Today on a phone", () => {
    layout.mobile = true;
    render(<Home />);
    expect(screen.getByText("Mobile Today")).toBeVisible();
  });
});
