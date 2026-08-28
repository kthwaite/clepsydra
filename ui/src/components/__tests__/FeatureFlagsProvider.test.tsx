import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const useFeaturesMock = vi.hoisted(() => vi.fn());

vi.mock("#/api/features", () => ({
  DISABLED_FEATURES: { academic: false, feeds: false },
  useFeatures: useFeaturesMock,
}));

import {
  FeatureFlagsProvider,
  useFeatureFlags,
} from "#/components/FeatureFlagsProvider";

function FeatureSnapshot() {
  const flags = useFeatureFlags();
  return (
    <div>
      academic:{flags.academic ? "on" : "off"} feeds:
      {flags.feeds ? "on" : "off"}
    </div>
  );
}

function renderProvider(children: ReactNode = <FeatureSnapshot />) {
  return render(<FeatureFlagsProvider>{children}</FeatureFlagsProvider>);
}

describe("FeatureFlagsProvider", () => {
  it("withholds children while capabilities load", () => {
    useFeaturesMock.mockReturnValue({
      data: undefined,
      isError: false,
      isPending: true,
    });

    renderProvider(<div>application</div>);

    expect(screen.queryByText("application")).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading features" }),
    ).toBeVisible();
  });

  it("provides server feature values", async () => {
    useFeaturesMock.mockReturnValue({
      data: { academic: true, feeds: false },
      isError: false,
      isPending: false,
    });

    renderProvider();

    expect(await screen.findByText("academic:on feeds:off")).toBeVisible();
  });

  it("fails closed when capability loading fails", async () => {
    useFeaturesMock.mockReturnValue({
      data: undefined,
      isError: true,
      isPending: false,
    });

    renderProvider();

    expect(await screen.findByText("academic:off feeds:off")).toBeVisible();
  });
});
