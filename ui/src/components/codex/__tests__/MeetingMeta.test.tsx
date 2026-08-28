import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "#/api/types";

const { usePageMock, usePagesMock, createMutateAsync, commitMock } = vi.hoisted(
  () => ({
    usePageMock: vi.fn(),
    usePagesMock: vi.fn(),
    createMutateAsync: vi.fn(),
    commitMock: vi.fn(),
  }),
);
vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  usePages: usePagesMock,
  useCreatePage: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => commitMock }));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

import { MeetingMeta } from "../MeetingMeta";

function page(attendees?: unknown, occurredAt?: unknown) {
  return {
    data: {
      path: "meetings/kickoff.md",
      kind: "MEETING",
      meta: { id: "page-uuid", attendees, occurred_at: occurredAt },
    },
  };
}

function person(path: string, title: string): PageSummary {
  return {
    id: path,
    path,
    title,
    aliases: [],
    canonical_name: title,
    computed_tags: [],
    encrypted: false,
    inferred: false,
    kind: "PERSON",
    tags: [],
  };
}

const people = [
  person("people/ada.md", "Ada"),
  person("people/grace.md", "Grace Hopper"),
];

function renderMeta({
  tags = [],
  onTagsChange = vi.fn(),
  isDraft = false,
}: {
  tags?: string[];
  onTagsChange?: (next: string[]) => void;
  isDraft?: boolean;
} = {}) {
  render(
    <MeetingMeta
      path="meetings/kickoff.md"
      tabId="t1"
      isDraft={isDraft}
      tags={tags}
      onTagsChange={onTagsChange}
    />,
  );
  return { onTagsChange };
}

const combobox = () => screen.getByRole("combobox", { name: "add attendee" });

beforeEach(() => {
  vi.clearAllMocks();
  commitMock.mockResolvedValue(undefined);
  usePagesMock.mockReturnValue({ data: { items: people } });
  createMutateAsync.mockImplementation(async (vars) => ({
    path: vars.params.path.path,
  }));
});

describe("MeetingMeta", () => {
  it("labels itself as a landmark the document header can carry", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    renderMeta();

    expect(
      screen.getByRole("region", { name: "Meeting details" }),
    ).toBeInTheDocument();
  });

  it("lists the people a meeting names", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]", "[[Grace]]"]));
    renderMeta();

    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
  });

  it("names any number of people and never captions a limit", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]", "[[Grace Hopper]]"]));
    renderMeta();

    expect(combobox()).toBeInTheDocument();
    expect(screen.queryByText(/names one person/)).toBeNull();
  });

  it("adds a picked person as a wikilink alongside the existing ones", async () => {
    const user = userEvent.setup();
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    renderMeta();

    await user.type(combobox(), "grace");
    await user.click(
      await screen.findByRole("option", { name: /Grace Hopper/ }),
    );

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "attendees",
        ["[[Ada]]", "[[Grace Hopper]]"],
        undefined,
      ),
    );
  });

  it("does not offer, or re-add, someone already named", async () => {
    const user = userEvent.setup();
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    renderMeta();

    await user.click(combobox());
    expect(
      await screen.findByRole("option", { name: /Grace Hopper/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /^Ada$/ })).toBeNull();

    await user.type(combobox(), "ada{Enter}");
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("clears the key rather than storing an empty list", async () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    renderMeta();

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

  it("removes one person and keeps the rest", async () => {
    usePageMock.mockReturnValue(page(["[[Ada]]", "[[Grace Hopper]]"]));
    renderMeta();

    fireEvent.click(
      screen.getByRole("button", { name: "remove Grace Hopper" }),
    );

    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        { id: "page-uuid", path: "meetings/kickoff.md" },
        "attendees",
        ["[[Ada]]"],
        undefined,
      ),
    );
  });

  it("links an attendee to the page that carries the name", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    renderMeta();

    expect(screen.getByRole("link", { name: "Ada" })).toHaveAttribute(
      "href",
      "/pages/people/ada.md",
    );
    expect(screen.queryByRole("button", { name: "create Ada" })).toBeNull();
  });

  it("offers to create the person page for a name no page carries", async () => {
    usePageMock.mockReturnValue(page(["[[Grace]]"]));
    renderMeta();

    expect(screen.queryByRole("link", { name: "Grace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "create Grace" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const [vars] = createMutateAsync.mock.calls[0];
    expect(vars.params.path.path).toMatch(
      /^people\/\d{8}\.grace\.[0-9A-Za-z]{8}\.md$/,
    );
    expect(vars.body).toEqual({ title: "Grace", kind: "PERSON" });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("tags the meeting 1:1 without touching other tags", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    const { onTagsChange } = renderMeta({ tags: ["weekly"] });

    const toggle = screen.getByRole("button", { name: "1:1" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    expect(onTagsChange).toHaveBeenCalledWith(["weekly", "1:1"]);
  });

  it("untags a 1:1", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"]));
    const { onTagsChange } = renderMeta({ tags: ["weekly", "1:1"] });

    const toggle = screen.getByRole("button", { name: "1:1" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);

    expect(onTagsChange).toHaveBeenCalledWith(["weekly"]);
  });

  it("shows the recorded time and offers no shortcut once it is set", () => {
    usePageMock.mockReturnValue(page(["[[Ada]]"], "2026-08-27T14:00:00Z"));
    renderMeta();

    expect(screen.getByText("2026-08-27T14:00:00Z")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Now" }),
    ).not.toBeInTheDocument();
  });

  it("stamps the current local time with the datetime hint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 27, 14, 0, 0));
    try {
      usePageMock.mockReturnValue(page(["[[Ada]]"], undefined));
      renderMeta();

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
    usePageMock.mockReturnValue(page(["[[Ada]]"], "2026-08-27T14:00:00Z"));
    renderMeta();

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
    usePageMock.mockReturnValue(page(["[[Ada]]"], "2026-08-27T14:00:00Z"));
    renderMeta();

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
    usePageMock.mockReturnValue(page(["[[Grace]]"]));
    renderMeta({ isDraft: true });

    expect(
      screen.queryByRole("combobox", { name: "add attendee" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Now" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "create Grace" })).toBeNull();
    expect(screen.getByRole("button", { name: "remove Grace" })).toBeDisabled();
    expect(commitMock).not.toHaveBeenCalled();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});
