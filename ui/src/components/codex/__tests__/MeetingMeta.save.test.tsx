import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import { usePageEditor } from "#/editor/usePageEditor";
import { MeetingMeta } from "../MeetingMeta";

const PATH = "meetings/kickoff.md";

function MeetingEditor() {
  const editor = usePageEditor(PATH);
  if (editor.isLoading) return <p>Loading meeting</p>;
  return (
    <>
      <textarea
        aria-label="Meeting notes"
        value={editor.getPlaintext()}
        disabled={editor.readonly}
        onChange={(event) => editor.setBodyMarkdown(event.target.value)}
      />
      <MeetingMeta
        path={PATH}
        tabId="meeting"
        isDraft={editor.isDraft}
        readOnly={editor.readonly && !editor.generatedChangePending}
        beginMetadataChange={editor.beginGeneratedChange}
      />
      <button type="button" onClick={() => void editor.saveNow()}>
        Save notes
      </button>
      <output aria-label="Save status">{editor.saveStatus}</output>
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

it("preserves unsaved meeting notes when removing an attendee and saving again", async () => {
  const user = userEvent.setup();
  let page = {
    path: PATH,
    canonical_name: "Kickoff",
    kind: "MEETING",
    inferred: false,
    project: null,
    encrypted: false,
    encryption: null,
    readonly: false,
    body: "Original notes.\n",
    revision: "revision-1",
    meta: {
      id: "meeting-id",
      title: "Kickoff",
      tags: [],
      aliases: [],
      created_at: null,
      updated_at: null,
      attendees: ["[[Ada]]", "[[Grace]]"],
    },
  };
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const writes: string[] = [];
  vi.spyOn(fetchClient, "GET").mockImplementation(async (route) => {
    const response = Response.json(
      route === "/api/vault/pages" ? { items: [], total: 0, offset: 0 } : page,
    );
    return { data: await response.json(), response };
  });
  vi.spyOn(fetchClient, "PUT").mockImplementation(
    async (_route, options?: { body?: unknown }) => {
      const request = options?.body;
      if (
        !request ||
        typeof request !== "object" ||
        !("body" in request) ||
        typeof request.body !== "string"
      ) {
        throw new Error("Expected a page-body save");
      }
      writes.push("notes");
      await saveGate;
      page = { ...page, body: request.body, revision: "revision-2" };
      const response = Response.json(page);
      return { data: await response.json(), response };
    },
  );
  vi.spyOn(fetchClient, "PATCH").mockImplementation(
    async (_route, options?: { body?: unknown }) => {
      const request = options?.body;
      if (
        !request ||
        typeof request !== "object" ||
        !("set" in request) ||
        !("expected_revision" in request)
      )
        throw new Error("Expected a property patch");
      expect(request.expected_revision).toBe("revision-2");
      expect(request.set).toEqual({ attendees: ["[[Grace]]"] });
      writes.push("attendees");
      page = {
        ...page,
        revision: "revision-3",
        meta: { ...page.meta, attendees: ["[[Grace]]"] },
      };
      const response = Response.json({ revision: page.revision });
      return { data: await response.json(), response };
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MeetingEditor />
    </QueryClientProvider>,
  );
  const notes = await screen.findByRole("textbox", { name: "Meeting notes" });
  fireEvent.change(notes, {
    target: { value: "Handwritten notes survive.\n" },
  });
  await user.click(screen.getByRole("button", { name: "remove Ada" }));
  expect(writes).toEqual(["notes"]);
  expect(notes).toBeDisabled();

  await act(async () => releaseSave());
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "remove Ada" })).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: "remove Grace" }),
  ).toBeInTheDocument();
  expect(notes).toHaveValue("Handwritten notes survive.\n");
  await user.click(screen.getByRole("button", { name: "Save notes" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Save status")).toHaveTextContent("saved"),
  );
  expect(page.body).toBe("Handwritten notes survive.\n");
  expect(writes).toEqual(["notes", "attendees"]);
  view.unmount();
  client.clear();
});
