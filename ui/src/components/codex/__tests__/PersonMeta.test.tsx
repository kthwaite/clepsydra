import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePageMock, commitMock } = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  commitMock: vi.fn(),
}));
vi.mock("#/api/pages", () => ({ usePage: usePageMock }));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => commitMock }));

import { PersonMeta } from "../PersonMeta";

const PAGE = { id: "page-uuid", path: "people/ada.md" };

function page(birthday?: unknown) {
  return {
    data: { path: PAGE.path, kind: "PERSON", meta: { id: PAGE.id, birthday } },
  };
}

function renderMeta(isDraft = false) {
  render(
    <PersonMeta
      path={PAGE.path}
      tabId="t1"
      isDraft={isDraft}
      tags={[]}
      onTagsChange={vi.fn()}
    />,
  );
}

const yearUnknown = () =>
  screen.getByRole("checkbox", { name: "Year unknown" });
const editButton = () => screen.getByRole("button", { name: "Edit birthday" });
const dateInput = () => screen.getByLabelText("birthday");

function editTo(value: string) {
  fireEvent.click(editButton());
  fireEvent.change(dateInput(), { target: { value } });
  fireEvent.blur(dateInput());
}

beforeEach(() => {
  vi.clearAllMocks();
  commitMock.mockResolvedValue(undefined);
});

describe("PersonMeta", () => {
  it("labels itself as a landmark the document header can carry", () => {
    usePageMock.mockReturnValue(page());
    renderMeta();
    expect(
      screen.getByRole("region", { name: "Person details" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Birthday")).toBeInTheDocument();
  });

  it("shows a full birthday with the year known", () => {
    usePageMock.mockReturnValue(page("1983-05-12"));
    renderMeta();
    expect(editButton()).toHaveTextContent("12 May 1983");
    expect(yearUnknown()).not.toBeChecked();
  });

  it.each(["05-12", "--05-12"])(
    "shows a yearless birthday stored as %j",
    (stored) => {
      usePageMock.mockReturnValue(page(stored));
      renderMeta();
      expect(editButton()).toHaveTextContent("12 May");
      expect(editButton()).not.toHaveTextContent("2000");
      expect(yearUnknown()).toBeChecked();
    },
  );

  it("shows a dash when no birthday is set", () => {
    usePageMock.mockReturnValue(page());
    renderMeta();
    expect(editButton()).toHaveTextContent("—");
  });

  it("sets a full birthday as a native date", async () => {
    usePageMock.mockReturnValue(page());
    renderMeta();
    editTo("1983-05-12");
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        "1983-05-12",
        "date",
      ),
    );
  });

  it("edits a yearless birthday through a leap-year picker, keeping it yearless", async () => {
    usePageMock.mockReturnValue(page("02-29"));
    renderMeta();
    fireEvent.click(editButton());
    expect(dateInput()).toHaveAttribute("type", "date");
    expect(dateInput()).toHaveValue("2000-02-29");
    fireEvent.change(dateInput(), { target: { value: "2000-06-01" } });
    fireEvent.blur(dateInput());
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        "06-01",
        undefined,
      ),
    );
  });

  it("clears the key", async () => {
    usePageMock.mockReturnValue(page("1983-05-12"));
    renderMeta();
    editTo("");
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        null,
        undefined,
      ),
    );
  });

  it("drops the year when marked unknown", async () => {
    const user = userEvent.setup();
    usePageMock.mockReturnValue(page("1983-05-12"));
    renderMeta();
    await user.click(yearUnknown());
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        "05-12",
        undefined,
      ),
    );
  });

  it("asks for the year when unmarked, and stores the full date", async () => {
    const user = userEvent.setup();
    usePageMock.mockReturnValue(page("05-12"));
    renderMeta();
    await user.click(yearUnknown());
    expect(commitMock).not.toHaveBeenCalled();
    expect(dateInput()).toHaveValue("2000-05-12");
    fireEvent.change(dateInput(), { target: { value: "1983-05-12" } });
    fireEvent.blur(dateInput());
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        "1983-05-12",
        "date",
      ),
    );
  });

  it("does not invent year 2000 when the year prompt is left unchanged", () => {
    usePageMock.mockReturnValue(page("05-12"));
    renderMeta();
    fireEvent.click(yearUnknown());
    fireEvent.blur(dateInput());
    expect(commitMock).not.toHaveBeenCalled();
    expect(yearUnknown()).toBeChecked();
  });

  it("stores a new birthday yearless when marked unknown first", async () => {
    const user = userEvent.setup();
    usePageMock.mockReturnValue(page());
    renderMeta();
    await user.click(yearUnknown());
    expect(commitMock).not.toHaveBeenCalled();
    editTo("2000-07-04");
    await waitFor(() =>
      expect(commitMock).toHaveBeenCalledWith(
        PAGE,
        "birthday",
        "07-04",
        undefined,
      ),
    );
  });

  it("does not write while the page is still a draft", () => {
    usePageMock.mockReturnValue(page());
    renderMeta(true);
    expect(editButton()).toBeDisabled();
    expect(yearUnknown()).toBeDisabled();
  });
});
