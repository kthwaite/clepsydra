import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "#/lib/queryClient";
import { useWorkspaceStore } from "#/store/workspace";
import { FolioBoundary } from "../FolioBoundary";

function Boom(): never {
  throw new Error("boom");
}

let flakyThrows = true;

function FlakyChild() {
  if (flakyThrows) throw new Error("transient boom");
  return <p>recovered content</p>;
}

describe("FolioBoundary", () => {
  beforeEach(() => {
    flakyThrows = true;
    queryClient.clear();
    useWorkspaceStore.setState({
      tabs: [{ id: "t1", type: "page", path: "notes/gone.md", label: "gone" }],
      activeTabId: "t1",
    });
  });

  it("renders the error panel with the caught error, not a not-found claim", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    expect(screen.getByText("Folio hit an error.")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("Folio not found.")).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("logs the caught error with its component stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    expect(
      spy.mock.calls.some((call) =>
        String(call[0]).includes("FolioBoundary caught"),
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it("retry re-renders the children instead of latching the error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <FolioBoundary path="notes/gone.md">
        <FlakyChild />
      </FolioBoundary>,
    );
    expect(screen.getByText("Folio hit an error.")).toBeInTheDocument();

    flakyThrows = false;
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.getByText("recovered content")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("retry resets errored queries so they can refetch", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    await queryClient.prefetchQuery({
      queryKey: ["boundary-test-errored"],
      queryFn: () => Promise.reject(new Error("nope")),
      retry: false,
    });
    expect(queryClient.getQueryState(["boundary-test-errored"])?.status).toBe(
      "error",
    );

    render(
      <FolioBoundary path="notes/gone.md">
        <FlakyChild />
      </FolioBoundary>,
    );
    flakyThrows = false;
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(
      queryClient.getQueryState(["boundary-test-errored"])?.status,
    ).not.toBe("error");
    spy.mockRestore();
  });

  it("closes the active tab from the error panel", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <FolioBoundary path="notes/gone.md">
        <Boom />
      </FolioBoundary>,
    );
    await user.click(screen.getByRole("button", { name: /close tab/i }));
    expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
    spy.mockRestore();
  });
});
