import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteError } from "#/components/RouteError";

describe("RouteError offline branch", () => {
  it("explains an uncached page when offline", () => {
    const error = {
      status: 503,
      data: { code: "offline_uncached", url: "/api/vault/pages/x.md" },
    };
    render(<RouteError error={error} info={undefined} reset={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Not available offline" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This page hasn't been synced to this device yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("explains an uncached page when the thrown value is the bare openapi-react-query payload", () => {
    const error = { code: "offline_uncached", url: "/api/vault/pages/x.md" };
    render(<RouteError error={error} info={undefined} reset={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Not available offline" }),
    ).toBeInTheDocument();
  });

  it("falls through to the generic error otherwise", () => {
    render(
      <RouteError error={new Error("boom")} info={undefined} reset={vi.fn()} />,
    );
    expect(
      screen.getByRole("heading", { name: "Something went wrong" }),
    ).toBeInTheDocument();
  });
});
