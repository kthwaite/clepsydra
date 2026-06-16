import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMutate, geocodeMutate, geocodeState, locationState } = vi.hoisted(
  () => ({
    updateMutate: vi.fn(),
    geocodeMutate: vi.fn(),
    geocodeState: {
      data: undefined as unknown,
      isPending: false,
    },
    locationState: {
      data: undefined as unknown,
    },
  }),
);

vi.mock("#/api/location", () => ({
  useUpdateLocation: () => ({
    mutate: updateMutate,
    isPending: false,
    error: null,
  }),
  useGeocode: () => ({
    mutate: geocodeMutate,
    data: geocodeState.data,
    isPending: geocodeState.isPending,
  }),
  useLocation: () => ({ data: locationState.data }),
}));

import { LocationModal } from "#/components/codex/LocationModal";
import { useUiStore } from "#/store/ui";

describe("LocationModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geocodeState.data = undefined;
    geocodeState.isPending = false;
    locationState.data = undefined;
    useUiStore.setState({ isLocationOpen: true });
  });

  it("prefills the fields from the current location", () => {
    locationState.data = { latitude: 48.85, longitude: 2.35, label: "Paris" };
    render(<LocationModal />);
    expect(screen.getByRole("spinbutton", { name: /latitude/i })).toHaveValue(
      48.85,
    );
    expect(screen.getByRole("spinbutton", { name: /longitude/i })).toHaveValue(
      2.35,
    );
    expect(screen.getByRole("textbox", { name: /label/i })).toHaveValue(
      "Paris",
    );
  });

  it("returns null when closed", () => {
    useUiStore.setState({ isLocationOpen: false });
    const { container } = render(<LocationModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<LocationModal />);
    await user.click(screen.getByRole("spinbutton", { name: /latitude/i }));
    await user.keyboard("{Escape}");
    expect(useUiStore.getState().isLocationOpen).toBe(false);
  });

  it("saves manually entered coordinates", async () => {
    const user = userEvent.setup();
    render(<LocationModal />);
    await user.type(
      screen.getByRole("spinbutton", { name: /latitude/i }),
      "51.5",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: /longitude/i }),
      "-0.12",
    );
    await user.type(screen.getByRole("textbox", { name: /label/i }), "London");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [body] = updateMutate.mock.calls[0];
    expect(body).toEqual({
      latitude: 51.5,
      longitude: -0.12,
      label: "London",
    });
  });

  it("blocks save and shows an error for out-of-range latitude", async () => {
    const user = userEvent.setup();
    render(<LocationModal />);
    await user.type(
      screen.getByRole("spinbutton", { name: /latitude/i }),
      "120",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: /longitude/i }),
      "10",
    );
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText(/latitude must be between -90 and 90/i),
    ).toBeInTheDocument();
  });

  it("blocks save when coordinates are missing", async () => {
    const user = userEvent.setup();
    render(<LocationModal />);
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("searches the city query and fills fields from a selected candidate", async () => {
    const user = userEvent.setup();
    render(<LocationModal />);

    await user.type(screen.getByRole("textbox", { name: /search/i }), "Paris");
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(geocodeMutate).toHaveBeenCalledWith("Paris");

    // Simulate the geocode results arriving and re-render.
    geocodeState.data = [
      { label: "Paris, France", latitude: 48.85, longitude: 2.35 },
    ];
    render(<LocationModal />);

    await user.click(screen.getByRole("button", { name: /Paris, France/i }));
    await user.click(screen.getAllByRole("button", { name: /save/i })[1]);

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [body] = updateMutate.mock.calls[0];
    expect(body).toEqual({
      latitude: 48.85,
      longitude: 2.35,
      label: "Paris, France",
    });
  });

  it("fills coordinates from browser geolocation", async () => {
    const user = userEvent.setup();
    const getCurrentPosition = vi.fn((success: PositionCallback) =>
      success({
        coords: {
          latitude: 40.71,
          longitude: -74.0,
          accuracy: 1,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition),
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition },
    });

    render(<LocationModal />);
    await user.click(
      screen.getByRole("button", { name: /use my current location/i }),
    );

    expect(getCurrentPosition).toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: /latitude/i })).toHaveValue(
      40.71,
    );
    expect(screen.getByRole("spinbutton", { name: /longitude/i })).toHaveValue(
      -74,
    );

    vi.unstubAllGlobals();
  });
});
