import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Middleware } from "openapi-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
import type { paths } from "#/api/schema";
import { TemplateSourceEditor } from "../TemplateSourceEditor";

vi.mock("#/api/client", async () => {
  // Vitest hoists this module factory before static runtime imports initialize.
  const { default: createFetchClient } = await import("openapi-fetch");
  const { default: createClient } = await import("openapi-react-query");
  const fetchClient = createFetchClient<paths>({ baseUrl: "http://localhost" });
  return { fetchClient, $api: createClient(fetchClient) };
});

const transport: Middleware = {
  onRequest({ request }) {
    if (!request.url.includes("/base-templates/notes")) return;
    if (request.method === "GET")
      return Response.json({
        slug: "notes",
        source: "Original source",
        revision: "revision-one",
      });
    if (request.method === "PUT")
      return Response.json(
        {
          status: 409,
          error: "Template was changed in an external editor",
          detail: { code: "revision_conflict" },
        },
        { status: 409 },
      );
  },
};
afterEach(() => fetchClient.eject(transport));

describe("template source editing", () => {
  it("keeps the authored source draft when saving conflicts with an external edit", async () => {
    fetchClient.use(transport);
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <TemplateSourceEditor
          slug="notes"
          onSaved={vi.fn()}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const source = await screen.findByDisplayValue("Original source");
    await user.clear(source);
    await user.type(source, "My unsaved template draft");
    await user.click(screen.getByRole("button", { name: "Save template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template was changed in an external editor",
    );
    expect(screen.getByLabelText("Template source")).toHaveValue(
      "My unsaved template draft",
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
