import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "#/components/ui/tag-input";

describe("TagInput", () => {
  it("renders label and existing tags", () => {
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={() => {}} />,
    );
    expect(screen.getByText("Tags:")).toBeDefined();
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
  });

  it("renders placeholder when empty", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        onChange={() => {}}
        placeholder="Add tag..."
      />,
    );
    expect(screen.getByPlaceholderText("Add tag...")).toBeDefined();
  });

  it("hides placeholder when values exist", () => {
    render(
      <TagInput
        label="Tags"
        values={["alpha"]}
        onChange={() => {}}
        placeholder="Add tag..."
      />,
    );
    expect(screen.queryByPlaceholderText("Add tag...")).toBeNull();
  });

  it("renders read-only values without remove controls", () => {
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("journal")).toBeInTheDocument();
    expect(screen.getByText("pkm")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").parentElement).toHaveTextContent("pkm");
  });

  it("hides the placeholder when only read-only values exist", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        readOnlyValues={["journal"]}
        onChange={() => {}}
        placeholder="Add tag..."
      />,
    );

    expect(screen.queryByPlaceholderText("Add tag...")).toBeNull();
  });

  it("adds tag on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["alpha"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "beta{Enter}");
    expect(onChange).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("adds tag on comma", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "gamma,");
    expect(onChange).toHaveBeenCalledWith(["gamma"]);
  });

  it("trims whitespace when adding", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "  delta  {Enter}");
    expect(onChange).toHaveBeenCalledWith(["delta"]);
  });

  it("does not add duplicate tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["alpha"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "alpha{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not add a read-only value to editable values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("textbox"), "journal{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });
  it.each(["JOURNAL", " journal "])(
    "does not add the read-only value variant %j",
    async (candidate) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <TagInput
          label="Tags"
          values={["pkm"]}
          readOnlyValues={["journal"]}
          onChange={onChange}
        />,
      );

      await user.type(screen.getByRole("textbox"), `${candidate}{Enter}`);

      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("emits only editable values when adding a tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("textbox"), "daily{Enter}");

    expect(onChange).toHaveBeenCalledWith(["pkm", "daily"]);
    expect(onChange).not.toHaveBeenCalledWith(
      expect.arrayContaining(["journal"]),
    );
  });

  it("preserves an ordinary value that matches another caller's derived tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["journal"]} onChange={onChange} />);

    await user.type(screen.getByRole("textbox"), "daily{Enter}");

    expect(onChange).toHaveBeenCalledWith(["journal", "daily"]);
  });
  it("allows an ordinary tag when no matching read-only value exists", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);

    await user.type(screen.getByRole("textbox"), "journal{Enter}");

    expect(onChange).toHaveBeenCalledWith(["journal"]);
  });

  it("does not add empty tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes last tag on Backspace when input is empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenCalledWith(["alpha"]);
  });

  it("Backspace removes only the last editable value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Backspace}");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("removes a specific tag via remove button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={onChange} />,
    );
    const removeButtons = screen.getAllByRole("button");
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith(["beta"]);
  });

  it("adds tag on blur when input has value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <TagInput label="Tags" values={[]} onChange={onChange} />
        <button type="button">other</button>
      </>,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "epsilon");
    await user.click(screen.getByText("other"));
    expect(onChange).toHaveBeenCalledWith(["epsilon"]);
  });

  it("has accessible tag group", () => {
    render(<TagInput label="Tags" values={["alpha"]} onChange={() => {}} />);
    expect(screen.getByRole("grid")).toBeDefined();
  });

  it("matches case-insensitively and excludes attached and derived tags", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={["rust"]}
        readOnlyValues={["brunch"]}
        suggestions={["rust", "brunch", "RUMination", "slate"]}
        onChange={() => {}}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "rU");

    expect(
      screen.getByRole("option", { name: "RUMination" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "rust" })).toBeNull();
    expect(screen.queryByRole("option", { name: "brunch" })).toBeNull();
    expect(screen.queryByRole("option", { name: "slate" })).toBeNull();
  });

  it("does not show suggestions for empty input", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust"]}
        onChange={() => {}}
      />,
    );

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });

  it("preserves textbox semantics when suggestions are omitted", () => {
    render(<TagInput label="Tags" values={[]} onChange={() => {}} />);

    expect(
      screen.getByRole("textbox", { name: "Add tags" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });
  it("excludes read-only variants before selecting a suggestion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        readOnlyValues={["journal"]}
        suggestions={["JOURNAL", " journal ", "journal-entry"]}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "jour");

    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("option", { name: "journal-entry" }));

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(["journal-entry"]);
  });

  it("does not show suggestions when suggestions are omitted", async () => {
    const user = userEvent.setup();
    render(<TagInput label="Tags" values={[]} onChange={() => {}} />);

    await user.type(screen.getByRole("textbox", { name: "Add tags" }), "ru");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });

  it("commits the raw draft on Enter while suggestions are open", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["research", "react"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "re");
    expect(
      screen.getByRole("listbox", { name: "Tag suggestions" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(["re"]);
  });

  it("commits only the mouse-selected suggestion before blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["research", "react"]}
        onChange={onChange}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "re");
    fireEvent.mouseDown(screen.getByRole("option", { name: "research" }));
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(["research"]);
  });

  it("renders at most five matching suggestions", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["alpha", "beta", "gamma", "delta", "zeta", "eta"]}
        onChange={() => {}}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "a");

    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.queryByRole("option", { name: "eta" })).toBeNull();
  });

  it("honors a caller-provided suggestion limit", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]}
        maxSuggestions={8}
        onChange={() => {}}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "a");
    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  it("reports each query and renders responsive server suggestions", async () => {
    const user = userEvent.setup();
    const onSuggestionQueryChange = vi.fn();
    const view = render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["clep-note"]}
        onSuggestionQueryChange={onSuggestionQueryChange}
        onChange={() => {}}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Add tags" });

    await user.type(input, "clep");
    expect(onSuggestionQueryChange).toHaveBeenLastCalledWith("clep");
    expect(screen.getByRole("option", { name: "clep-note" })).toBeVisible();

    view.rerender(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["clepsydra"]}
        onSuggestionQueryChange={onSuggestionQueryChange}
        onChange={() => {}}
      />,
    );
    await user.type(input, "sydra");

    expect(onSuggestionQueryChange).toHaveBeenLastCalledWith("clepsydra");
    expect(screen.getByRole("option", { name: "clepsydra" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "clep-note" })).toBeNull();
  });

  it("announces suggestion loading without presenting stale options", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={[]}
        suggestionsLoading
        onSuggestionQueryChange={() => {}}
        onChange={() => {}}
      />,
    );
    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "clep");

    expect(screen.getByRole("status")).toHaveTextContent(
      /loading tag suggestions/i,
    );
    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });

  it("exposes suggestion errors and retry while preserving raw commit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onRetrySuggestions = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={[]}
        suggestionsError={new Error("tag suggestions unavailable")}
        onRetrySuggestions={onRetrySuggestions}
        onSuggestionQueryChange={() => {}}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(input, "ad-hoc");

    expect(screen.getByRole("alert")).toHaveTextContent(
      /tag suggestions unavailable/i,
    );
    await user.click(
      screen.getByRole("button", { name: /retry tag suggestions/i }),
    );
    expect(onRetrySuggestions).toHaveBeenCalledOnce();

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(["ad-hoc"]);
  });

  it("links the combobox to its listbox and active option across navigation", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react"]}
        onChange={() => {}}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(combobox, "r");
    const listbox = screen.getByRole("listbox", { name: "Tag suggestions" });
    const initialOption = screen.getByRole("option", { selected: true });

    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    expect(combobox).toHaveAttribute("aria-activedescendant", initialOption.id);

    await user.keyboard("{ArrowDown}");
    const navigatedOption = screen.getByRole("option", { selected: true });

    expect(navigatedOption.id).not.toBe(initialOption.id);
    expect(combobox).toHaveAttribute("aria-controls", listbox.id);
    expect(combobox).toHaveAttribute(
      "aria-activedescendant",
      navigatedOption.id,
    );
  });

  it("tab-completes the initially highlighted suggestion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Tab}");

    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("commits the arrow-highlighted suggestion on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["react"]);
  });

  it("keeps the first suggestion highlighted on ArrowUp", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowUp}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("keeps the last suggestion highlighted on repeated ArrowDown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["ritual"]);
  });

  it("reopens dismissed suggestions on ArrowDown", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react"]}
        onChange={() => {}}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();

    await user.keyboard("{ArrowDown}");

    expect(
      screen.getByRole("listbox", { name: "Tag suggestions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "react" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders a display prefix without storing it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["rust"]}
        suggestions={["react"]}
        valuePrefix="#"
        onChange={onChange}
      />,
    );

    expect(screen.getByText("#rust")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "#re");
    expect(screen.getByRole("option", { name: "#react" })).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenCalledWith(["rust", "react"]);
  });

  it("normalizes one display prefix on keyboard and blur commits", async () => {
    const user = userEvent.setup();
    const keyboardChange = vi.fn();
    const blurChange = vi.fn();
    render(
      <>
        <TagInput
          label="Keyboard Tags"
          values={[]}
          valuePrefix="#"
          onChange={keyboardChange}
        />
        <TagInput
          label="Blur Tags"
          values={[]}
          valuePrefix="#"
          onChange={blurChange}
        />
      </>,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Add keyboard tags" }),
      "##rust{Enter}",
    );
    expect(keyboardChange).toHaveBeenCalledWith(["#rust"]);

    await user.type(
      screen.getByRole("textbox", { name: "Add blur tags" }),
      "##rust",
    );
    await user.tab();
    expect(blurChange).toHaveBeenCalledWith(["#rust"]);
  });

  it("swallows Escape while suggestions are open, then bubbles it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const containerKey = vi.fn();
    render(
      <div
        onKeyDown={(event) => {
          if (event.key === "Escape") containerKey();
        }}
      >
        <TagInput
          label="Tags"
          values={[]}
          suggestions={["rust"]}
          valuePrefix="#"
          onChange={onChange}
        />
      </div>,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ru");
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(containerKey).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(containerKey).toHaveBeenCalledTimes(1);
  });
  it("rejects a non-vocabulary draft when creation is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["research", "rust"]}
        allowCreate={false}
        onChange={onChange}
      />,
    );

    await user.type(
      screen.getByRole("combobox", { name: "Add tags" }),
      "unknown{Enter}",
    );
    expect(onChange).not.toHaveBeenCalled();
  });
  it("commits the active matching suggestion on Enter when creation is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["research"]}
        allowCreate={false}
        onChange={onChange}
      />,
    );

    const combobox = screen.getByRole("combobox", { name: "Add tags" });
    await user.type(combobox, "res");
    const activeOption = screen.getByRole("option", { selected: true });
    expect(activeOption).toHaveTextContent("research");
    expect(combobox).toHaveAttribute("aria-activedescendant", activeOption.id);

    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(["research"]);
  });

  it("commits canonical vocabulary spelling when creation is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["Research"]}
        allowCreate={false}
        onChange={onChange}
      />,
    );

    await user.type(
      screen.getByRole("combobox", { name: "Add tags" }),
      " research {Enter}",
    );
    expect(onChange).toHaveBeenCalledWith(["Research"]);
  });

  it("keeps free tag creation enabled by default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={[]}
        onChange={onChange}
      />,
    );
    await user.type(
      screen.getByRole("combobox", { name: "Add tags" }),
      "new-tag{Enter}",
    );
    expect(onChange).toHaveBeenCalledWith(["new-tag"]);
  });

  it("rejects an unknown draft on blur when creation is disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <TagInput
          label="Tags"
          values={[]}
          suggestions={["research"]}
          allowCreate={false}
          onChange={onChange}
        />
        <button type="button">Elsewhere</button>
      </>,
    );

    await user.type(
      screen.getByRole("combobox", { name: "Add tags" }),
      "unknown",
    );
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
