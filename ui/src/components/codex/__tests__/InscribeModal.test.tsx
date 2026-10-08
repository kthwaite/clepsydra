import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "#/api/types";

const { createMutate, createMutateAsync, openTabMock, people } = vi.hoisted(
  () => {
    const person = (path: string, title: string) => ({
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
    });
    return {
      createMutate: vi.fn(),
      createMutateAsync: vi.fn(),
      openTabMock: vi.fn(),
      people: [
        person("people/ada.md", "Ada"),
        person("people/grace.md", "Grace Hopper"),
      ] as PageSummary[],
    };
  },
);

vi.mock("#/api/pages", () => ({
  useCreatePage: () => ({
    mutate: createMutate,
    mutateAsync: createMutateAsync,
    isPending: false,
  }),
  usePages: () => ({ data: { items: people } }),
}));
vi.mock("#/api/index", () => ({
  useTags: () => ({
    data: [
      { tag: "rust", count: 4 },
      { tag: "ritual", count: 1 },
    ],
  }),
}));
vi.mock("#/lib/useProjects", () => ({
  useProjects: () => ["clepsydra", "aleph"],
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { InscribeModal } from "#/components/codex/InscribeModal";
import { useUiStore } from "#/store/ui";

describe("InscribeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ isInscribeOpen: true });
  });

  it("offers kind + project controls instead of a designation textbox", () => {
    render(<InscribeModal />);
    expect(screen.getByRole("combobox", { name: "Kind" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Project" }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("ideas/new-page")).toBeNull();
  });

  it("titles the modal and names its commit button Inscribe", () => {
    render(<InscribeModal />);
    expect(
      screen.getByRole("heading", { name: "Inscribe a new folio" }),
    ).toBeVisible();
    expect(
      screen.getByText("Kind and project decide where it is filed"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Inscribe" })).toHaveAttribute(
      "type",
      "submit",
    );
    expect(screen.queryByText(/commit to archive/)).toBeNull();
  });

  it("does not offer quotation as a creation kind", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);

    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    expect(screen.queryByRole("option", { name: "QUOTE" })).toBeNull();
    expect(screen.getByRole("option", { name: "Note" })).toBeVisible();
  });

  it("dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.click(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("{Escape}");
    expect(useUiStore.getState().isInscribeOpen).toBe(false);
  });

  it("cancels without creating or opening a page", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(false);
    expect(createMutate).not.toHaveBeenCalled();
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("resets local fields after backdrop dismissal", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InscribeModal />);
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.type(title, "Discard me");

    const overlay = document.body.querySelector(".fixed.inset-0");
    expect(overlay).toBeInstanceOf(HTMLElement);
    await user.click(overlay as HTMLElement);
    expect(useUiStore.getState().isInscribeOpen).toBe(false);

    useUiStore.setState({ isInscribeOpen: true });
    rerender(<InscribeModal />);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("");
  });

  it("creates the page at the kind-projected canonical path", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(
      screen.getByRole("textbox", { name: "Title" }),
      "Redesign Retro",
    );
    await user.click(screen.getByRole("button", { name: "Inscribe" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    const [vars] = createMutate.mock.calls[0];
    expect(vars.params.path.path).toMatch(
      /^notes\/\d{8}\.redesign-retro\.[0-9A-Za-z]{8}\.md$/,
    );
    expect(vars.body.title).toBe("Redesign Retro");
  });

  it("persists the chosen recipe kind in the create mutation", async () => {
    const user = userEvent.setup();
    createMutate.mockImplementation((vars, opts) =>
      opts?.onSuccess?.({ path: vars.params.path.path }),
    );
    render(<InscribeModal />);
    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(screen.getByRole("option", { name: "Recipe" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Soup");
    await user.click(screen.getByRole("button", { name: "Inscribe" }));

    const [createVars] = createMutate.mock.calls[0];
    expect(createVars.body.kind).toBe("RECIPE");
    expect(createVars.params.path.path).toMatch(/^recipes\//);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      expect.stringMatching(/^recipes\//),
      "Soup",
    );
    expect(useUiStore.getState().isInscribeOpen).toBe(false);
  });

  it("keeps the dialog open with the create API error", async () => {
    const user = userEvent.setup();
    createMutate.mockImplementationOnce((_vars, opts) =>
      opts?.onError?.({ error: "page already exists" }),
    );
    render(<InscribeModal />);

    await user.type(screen.getByRole("textbox", { name: "Title" }), "Hello");
    await user.click(screen.getByRole("button", { name: "Inscribe" }));

    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    expect(screen.getByText(/page already exists/)).toBeInTheDocument();
    expect(openTabMock).not.toHaveBeenCalled();
  });

  it("requires a title", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.click(screen.getByRole("button", { name: "Inscribe" }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/title is required/)).toBeInTheDocument();
  });

  it("creates a one-to-one through the ordinary tags input without duplicates", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(screen.getByRole("option", { name: "Meeting" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Ada");
    await user.type(
      screen.getByRole("combobox", { name: "Tags" }),
      "1:1{Enter}1:1{Enter}",
    );

    await user.click(screen.getByRole("button", { name: "Inscribe" }));

    const [vars] = createMutate.mock.calls[0];
    expect(vars.body.kind).toBe("MEETING");
    expect(vars.body.tags).toEqual(["1:1"]);
    expect(vars.params.path.path).toMatch(/^meetings\//);
  });

  it("never sends a project no PROJECT page declares", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(
      screen.getByRole("combobox", { name: "Project" }),
      "ghost{Enter}",
    );

    expect(screen.getByRole("status")).toHaveTextContent("No such project.");
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(
      "ghost",
    );
    // The intercepted Enter must not have submitted the form.
    expect(createMutate).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Title" }), "Orphan");
    await user.click(screen.getByRole("button", { name: "Inscribe" }));

    expect(createMutate).toHaveBeenCalledTimes(1);
    const [vars] = createMutate.mock.calls[0];
    expect(vars.body).not.toHaveProperty("project");
    expect(vars.params.path.path).toMatch(/^notes\/\d{8}\.orphan\./);
  });

  it("sends a project picked from the declared list", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(screen.getByRole("combobox", { name: "Project" }), "al");
    await user.click(await screen.findByRole("option", { name: "aleph" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Filed");
    await user.click(screen.getByRole("button", { name: "Inscribe" }));

    const [vars] = createMutate.mock.calls[0];
    expect(vars.body.project).toBe("aleph");
    expect(vars.params.path.path).toMatch(/^notes\/aleph\/\d{8}\.filed\./);
  });

  it("sends committed tag chips with the create request", async () => {
    const user = userEvent.setup();
    render(<InscribeModal />);
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Tagged");
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "ru");
    expect(
      screen.getByRole("listbox", { name: "Tag suggestions" }),
    ).toBeVisible();
    await user.keyboard("{Tab}");
    expect(screen.getByText("#rust")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inscribe" }));
    const [vars] = createMutate.mock.calls[0];
    expect(vars.body.tags).toEqual(["rust"]);
  });

  describe("MEETING fields", () => {
    beforeEach(() => {
      // Only Date is faked so user-event's timers still run.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 8, 14, 37, 42));
      // An earlier test gives mutate an onSuccess that closes the modal.
      createMutate.mockReset();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const attendeeCombo = () =>
      screen.getByRole("combobox", { name: "Add attendee" });

    async function chooseKind(
      user: ReturnType<typeof userEvent.setup>,
      name: string,
    ) {
      await user.click(screen.getByRole("combobox", { name: "Kind" }));
      await user.click(screen.getByRole("option", { name }));
    }

    async function pickPerson(
      user: ReturnType<typeof userEvent.setup>,
      query: string,
      option: RegExp,
    ) {
      await user.type(attendeeCombo(), query);
      await user.click(await screen.findByRole("option", { name: option }));
      // PersonCombo refocuses after a pick, which reopens its popover (when
      // anyone is left to offer) and hides the rest of the form; Escape
      // closes only the popover.
      if (screen.queryByRole("listbox")) await user.keyboard("{Escape}");
      expect(useUiStore.getState().isInscribeOpen).toBe(true);
    }

    it("hides When and Attendees for other kinds and sends neither", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      expect(screen.queryByLabelText("When")).toBeNull();
      expect(
        screen.queryByRole("combobox", { name: "Add attendee" }),
      ).toBeNull();

      await user.type(screen.getByRole("textbox", { name: "Title" }), "Plain");
      await user.click(screen.getByRole("button", { name: "Inscribe" }));

      const [vars] = createMutate.mock.calls[0];
      expect(vars.body).not.toHaveProperty("attendees");
      expect(vars.body).not.toHaveProperty("occurred_at");
    });

    it("prefills When with the current minute and sends picked attendees", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      await chooseKind(user, "Meeting");

      expect(screen.getByLabelText("When")).toHaveValue("2026-10-08T14:37");
      await user.type(screen.getByRole("textbox", { name: "Title" }), "Sync");
      await pickPerson(user, "ad", /^Ada$/);
      await pickPerson(user, "gr", /Grace Hopper/);
      expect(screen.getByRole("list", { name: /Attendees/ })).toHaveTextContent(
        /Ada.*Grace Hopper/,
      );

      await user.click(screen.getByRole("button", { name: "Inscribe" }));

      const [vars] = createMutate.mock.calls[0];
      expect(vars.body.kind).toBe("MEETING");
      expect(vars.body.attendees).toEqual(["Ada", "Grace Hopper"]);
      expect(vars.body.occurred_at).toBe("2026-10-08T14:37:00");
    });

    it("sends an edited When and omits a cleared one", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      await chooseKind(user, "Meeting");
      await user.type(screen.getByRole("textbox", { name: "Title" }), "Retro");

      fireEvent.change(screen.getByLabelText("When"), {
        target: { value: "2026-10-07T09:30" },
      });
      await user.click(screen.getByRole("button", { name: "Inscribe" }));
      expect(createMutate.mock.calls[0][0].body.occurred_at).toBe(
        "2026-10-07T09:30:00",
      );

      fireEvent.change(screen.getByLabelText("When"), {
        target: { value: "" },
      });
      await user.click(screen.getByRole("button", { name: "Inscribe" }));
      const body = createMutate.mock.calls[1][0].body;
      expect(body).not.toHaveProperty("occurred_at");
      expect(body).not.toHaveProperty("attendees");
    });

    it("drops a removed chip and ignores a duplicate pick", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      await chooseKind(user, "Meeting");
      await user.type(screen.getByRole("textbox", { name: "Title" }), "Pair");
      await pickPerson(user, "gr", /Grace Hopper/);
      await user.type(attendeeCombo(), "ada{Enter}");
      await user.type(attendeeCombo(), "ADA{Enter}");
      expect(screen.getAllByRole("button", { name: /^remove / })).toHaveLength(
        2,
      );

      await user.click(
        screen.getByRole("button", { name: "remove Grace Hopper" }),
      );
      await user.click(screen.getByRole("button", { name: "Inscribe" }));

      expect(createMutate).toHaveBeenCalledTimes(1);
      const [vars] = createMutate.mock.calls[0];
      expect(vars.body.attendees).toEqual(["Ada"]);
    });

    it("sends neither field after switching from MEETING to another kind", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      await chooseKind(user, "Meeting");
      await pickPerson(user, "ad", /^Ada$/);
      await chooseKind(user, "Note");

      expect(screen.queryByLabelText("When")).toBeNull();
      await user.type(screen.getByRole("textbox", { name: "Title" }), "Later");
      await user.click(screen.getByRole("button", { name: "Inscribe" }));

      const [vars] = createMutate.mock.calls[0];
      expect(vars.body.kind).toBe("NOTE");
      expect(vars.body).not.toHaveProperty("attendees");
      expect(vars.body).not.toHaveProperty("occurred_at");
    });

    it("does not submit on Enter in the attendee combobox", async () => {
      const user = userEvent.setup();
      render(<InscribeModal />);
      await chooseKind(user, "Meeting");
      await user.type(screen.getByRole("textbox", { name: "Title" }), "Draft");

      // A partial name with the popover closed: nothing in PersonCombo
      // claims this Enter, so only the form guard stops the submit.
      await user.type(attendeeCombo(), "gr{Escape}");
      expect(screen.queryByRole("listbox")).toBeNull();
      await user.keyboard("{Enter}");

      expect(createMutate).not.toHaveBeenCalled();
      expect(attendeeCombo()).toHaveValue("gr");
    });

    it("clears attendees on dismissal", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<InscribeModal />);
      await chooseKind(user, "Meeting");
      await pickPerson(user, "ad", /^Ada$/);
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      useUiStore.setState({ isInscribeOpen: true });
      rerender(<InscribeModal />);
      await chooseKind(user, "Meeting");
      expect(screen.queryByRole("button", { name: "remove Ada" })).toBeNull();
    });
  });
});
