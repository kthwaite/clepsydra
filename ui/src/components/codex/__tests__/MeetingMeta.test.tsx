import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePageMock, commitMock } = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  commitMock: vi.fn(),
}));
vi.mock("#/api/pages", () => ({ usePage: usePageMock }));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => commitMock }));

import { MeetingMeta } from "../MeetingMeta";

function page(kind: string, attendees?: unknown, occurredAt?: unknown) {
  return {
    data: {
      path: "meetings/kickoff.md",
      kind,
      meta: { id: "page-uuid", attendees, occurred_at: occurredAt },
    },
  };
}

beforeEach(() => {
  commitMock.mockReset();
  commitMock.mockResolvedValue(undefined);
});

describe("MeetingMeta", () => {
  it("labels itself as a landmark the document header can carry", () => {
    usePageMock.mockReturnValue(page("MEETING", ["[[Ada]]"]));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    expect(
      screen.getByRole("region", { name: "Meeting details" }),
    ).toBeInTheDocument();
  });

  it("lists the people a meeting names", () => {
    usePageMock.mockReturnValue(page("MEETING", ["[[Ada]]", "[[Grace]]"]));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  it("adds an attendee as a wikilink alongside the existing ones", async () => {
    usePageMock.mockReturnValue(page("MEETING", ["[[Ada]]"]));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    fireEvent.change(screen.getByLabelText("add attendee"), {
      target: { value: "Grace Hopper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "attendees",
        ["[[Ada]]", "[[Grace Hopper]]"],
        undefined,
      ),
    );
  });

  it("clears the key rather than storing an empty list", async () => {
    usePageMock.mockReturnValue(page("MEETING", ["[[Ada]]"]));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "remove Ada" }));

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "attendees",
        null,
        undefined,
      ),
    );
  });

  it("stops offering an add field once a 1:1 names someone", () => {
    usePageMock.mockReturnValue(page("ONE_ON_ONE", ["[[Ada]]"]));
    render(
      <MeetingMeta path="one-on-ones/ada.md" tabId="t1" isDraft={false} />,
    );

    expect(screen.queryByLabelText("add attendee")).not.toBeInTheDocument();
    expect(screen.getByText("a 1:1 names one person")).toBeInTheDocument();
  });

  it("still offers the field on an empty 1:1", () => {
    usePageMock.mockReturnValue(page("ONE_ON_ONE", undefined));
    render(
      <MeetingMeta path="one-on-ones/ada.md" tabId="t1" isDraft={false} />,
    );

    expect(screen.getByText("nobody named yet")).toBeInTheDocument();
    expect(screen.getByLabelText("add attendee")).toBeInTheDocument();
  });

  it("shows the recorded time and offers no shortcut once it is set", () => {
    usePageMock.mockReturnValue(
      page("MEETING", ["[[Ada]]"], "2026-08-27T14:00:00Z"),
    );
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    expect(screen.getByText("2026-08-27T14:00:00Z")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Now" }),
    ).not.toBeInTheDocument();
  });

  it("stamps the current local time with the datetime hint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 27, 14, 0, 0));
    try {
      usePageMock.mockReturnValue(page("MEETING", ["[[Ada]]"], undefined));
      render(
        <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Now" }));

      // The hint is what keeps it a TOML date-time rather than a string.
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "occurred_at",
        "2026-08-27T14:00:00",
        "datetime",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("edits the time through the shared datetime picker", async () => {
    usePageMock.mockReturnValue(
      page("MEETING", ["[[Ada]]"], "2026-08-27T14:00:00Z"),
    );
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit occurred at" }));
    const input = screen.getByLabelText("occurred at");
    expect(input).toHaveAttribute("type", "datetime-local");

    fireEvent.change(input, { target: { value: "2026-08-28T09:30:00" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "occurred_at",
        // The stored value's zone suffix survives the edit.
        "2026-08-28T09:30:00Z",
        "datetime",
      ),
    );
  });

  it("clears the time without a hint, so the key is removed", async () => {
    usePageMock.mockReturnValue(
      page("MEETING", ["[[Ada]]"], "2026-08-27T14:00:00Z"),
    );
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={false} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit occurred at" }));
    fireEvent.change(screen.getByLabelText("occurred at"), {
      target: { value: "" },
    });
    fireEvent.blur(screen.getByLabelText("occurred at"));

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "occurred_at",
        null,
        undefined,
      ),
    );
  });

  it("does not write while the page is still a draft", () => {
    usePageMock.mockReturnValue(page("MEETING", undefined));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={true} />,
    );

    expect(screen.queryByLabelText("add attendee")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Now" }),
    ).not.toBeInTheDocument();
    expect(commitMock).not.toHaveBeenCalled();
  });
});
