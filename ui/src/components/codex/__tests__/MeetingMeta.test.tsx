import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePageMock, commitMock } = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  commitMock: vi.fn(),
}));
vi.mock("#/api/pages", () => ({ usePage: usePageMock }));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => commitMock }));

import { MeetingMeta } from "../MeetingMeta";

function page(kind: string, attendees?: unknown) {
  return {
    data: {
      path: "meetings/kickoff.md",
      kind,
      meta: { id: "page-uuid", attendees },
    },
  };
}

beforeEach(() => {
  commitMock.mockReset();
  commitMock.mockResolvedValue(undefined);
});

describe("MeetingMeta", () => {
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

  it("does not write while the page is still a draft", () => {
    usePageMock.mockReturnValue(page("MEETING", undefined));
    render(
      <MeetingMeta path="meetings/kickoff.md" tabId="t1" isDraft={true} />,
    );

    expect(screen.queryByLabelText("add attendee")).not.toBeInTheDocument();
    expect(commitMock).not.toHaveBeenCalled();
  });
});
