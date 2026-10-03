import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LazyMoonGlobe } from "./LazyMoonGlobe";
import MoonGlobe from "./MoonGlobe";

describe("MoonGlobe", () => {
  it("renders the fallback when WebGL is unavailable (jsdom)", () => {
    render(
      <MoonGlobe
        date={new Date("2026-10-03T13:00:00Z")}
        fallback={<p>flat moon</p>}
      />,
    );
    expect(screen.getByText("flat moon")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("lazy wrapper shows the fallback while loading and without WebGL", async () => {
    render(
      <LazyMoonGlobe
        date={new Date("2026-10-26T04:00:00Z")}
        fallback={<p>flat moon</p>}
      />,
    );
    expect(screen.getByText("flat moon")).toBeInTheDocument();
    expect(await screen.findByText("flat moon")).toBeInTheDocument();
  });
});
