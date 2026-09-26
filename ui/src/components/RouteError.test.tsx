import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(screen.getByText("Offline")).toBeInTheDocument();
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

describe("RouteError generic branch", () => {
  const apiError = Object.assign(
    new Error("The page index is rebuilding after sync"),
    {
      name: "ApiError",
      status: 503,
      statusText: "Service Unavailable",
      url: "https://clepsydra.localhost/api/vault/pages/x.md",
      data: { error: "index_rebuilding" },
    },
  );

  it("heads the error with an eyebrow, the message and a type · status meta line", () => {
    render(<RouteError error={apiError} info={undefined} reset={vi.fn()} />);
    expect(screen.getByText("Application error")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The page index is rebuilding after sync"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ApiError · HTTP 503 Service Unavailable"),
    ).toBeInTheDocument();
  });

  it("retries, reloads and discloses technical details in sentence case", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<RouteError error={apiError} info={undefined} reset={reset} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Reload app" }),
    ).toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: /(Show|Hide) technical details/,
    });
    if (toggle.getAttribute("aria-expanded") === "true") {
      await user.click(toggle);
    }
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("Show technical details");
    expect(
      screen.queryByRole("heading", { name: "Response" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide technical details");
    for (const name of ["Response", "Stack trace", "Raw error"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    for (const term of ["Status", "Status text", "URL"]) {
      expect(screen.getByText(term, { selector: "dt" })).toBeInTheDocument();
    }
    expect(screen.getByText("Service Unavailable", { selector: "dd" }));
  });
});
