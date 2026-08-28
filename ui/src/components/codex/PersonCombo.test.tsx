import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "#/api/types";

const { usePagesMock, createMutateAsync } = vi.hoisted(() => ({
  usePagesMock: vi.fn(),
  createMutateAsync: vi.fn(),
}));
vi.mock("#/api/pages", () => ({
  usePages: usePagesMock,
  // A fresh object per render, the way TanStack hands it out; only
  // mutateAsync is stable.
  useCreatePage: () => ({ mutateAsync: createMutateAsync, isPending: false }),
}));

import { PersonCombo } from "#/components/codex/PersonCombo";

function page(over: Partial<PageSummary> & { path: string }): PageSummary {
  return {
    id: over.path,
    aliases: [],
    canonical_name: over.path.replace(/^.*\//, "").replace(/\.md$/, ""),
    computed_tags: [],
    encrypted: false,
    inferred: false,
    kind: "PERSON",
    tags: [],
    ...over,
  };
}

const people = [
  page({ path: "people/grace.md", title: "Grace Hopper" }),
  page({ path: "people/ada.md", title: "Ada Lovelace", aliases: ["Ada"] }),
  page({ path: "notes/standup.md", title: "Standup", kind: "NOTE" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  usePagesMock.mockReturnValue({ data: { items: people } });
  createMutateAsync.mockImplementation(async (vars) => ({
    path: vars.params.path.path,
  }));
});

const combobox = () => screen.getByRole("combobox", { name: "add attendee" });

describe("PersonCombo", () => {
  it("lists PERSON pages, and only those, on focus", async () => {
    const user = userEvent.setup();
    render(<PersonCombo onPick={vi.fn()} />);

    await user.click(combobox());

    expect(
      await screen.findByRole("option", { name: /Ada Lovelace/ }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /Grace Hopper/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Standup/ })).toBeNull();
  });

  it("filters by what was typed, case-insensitively", async () => {
    const user = userEvent.setup();
    render(<PersonCombo onPick={vi.fn()} />);

    await user.type(combobox(), "gr");

    expect(
      await screen.findByRole("option", { name: /Grace Hopper/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();
  });

  it("hides people already named", async () => {
    const user = userEvent.setup();
    render(<PersonCombo onPick={vi.fn()} exclude={["Ada Lovelace"]} />);

    await user.click(combobox());

    expect(
      await screen.findByRole("option", { name: /Grace Hopper/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Ada Lovelace/ })).toBeNull();
  });

  it("offers to create a name no page carries", async () => {
    const user = userEvent.setup();
    render(<PersonCombo onPick={vi.fn()} />);

    await user.type(combobox(), "Alan Turing");

    expect(
      await screen.findByRole("option", { name: "Create “Alan Turing”" }),
    ).toBeVisible();
  });

  it("does not offer to create a name a page already carries", async () => {
    const user = userEvent.setup();
    render(<PersonCombo onPick={vi.fn()} exclude={["Grace Hopper"]} />);

    await user.type(combobox(), "ada lovelace");
    expect(
      await screen.findByRole("option", { name: /Ada Lovelace/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Create/ })).toBeNull();

    // Excluded people still count as existing pages.
    await user.clear(combobox());
    await user.type(combobox(), "grace hopper");
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Create/ })).toBeNull(),
    );
  });

  it("picks a person by click and clears the field", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PersonCombo onPick={onPick} />);

    await user.type(combobox(), "ada");
    await user.click(
      await screen.findByRole("option", { name: /Ada Lovelace/ }),
    );

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("Ada Lovelace");
    expect(combobox()).toHaveValue("");
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("picks the exact match on Enter, ignoring case", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PersonCombo onPick={onPick} />);

    await user.type(combobox(), "grace hopper{Enter}");

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("Grace Hopper");
    expect(combobox()).toHaveValue("");
  });

  it("keeps a partial draft on Enter rather than picking or creating", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PersonCombo onPick={onPick} />);

    await user.type(combobox(), "gra{Enter}");

    expect(onPick).not.toHaveBeenCalled();
    expect(createMutateAsync).not.toHaveBeenCalled();
    expect(combobox()).toHaveValue("gra");
  });

  it("creates the PERSON page, then picks the new name", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PersonCombo onPick={onPick} />);

    await user.type(combobox(), "Alan Turing");
    await user.click(
      await screen.findByRole("option", { name: "Create “Alan Turing”" }),
    );

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("Alan Turing"));
    expect(createMutateAsync).toHaveBeenCalledTimes(1);
    const [vars] = createMutateAsync.mock.calls[0];
    expect(vars.params.path.path).toMatch(
      /^people\/\d{8}\.alan-turing\.[0-9A-Za-z]{8}\.md$/,
    );
    expect(vars.body).toEqual({ title: "Alan Turing", kind: "PERSON" });
    expect(combobox()).toHaveValue("");
  });

  it("reports a failed creation and keeps the draft", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    createMutateAsync.mockRejectedValueOnce(new Error("boom"));
    render(<PersonCombo onPick={onPick} />);

    await user.type(combobox(), "Alan Turing");
    await user.click(
      await screen.findByRole("option", { name: "Create “Alan Turing”" }),
    );

    expect(await screen.findByText(/could not create/i)).toBeVisible();
    expect(onPick).not.toHaveBeenCalled();
    expect(combobox()).toHaveValue("Alan Turing");
  });

  it("is inert while disabled", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PersonCombo onPick={onPick} disabled />);

    expect(combobox()).toBeDisabled();
    await user.click(combobox());
    expect(screen.queryByRole("option")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });
});
