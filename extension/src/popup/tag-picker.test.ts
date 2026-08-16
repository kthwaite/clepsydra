import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTagPicker } from "./tag-picker";

const linkedom = createRequire(import.meta.url)("linkedom") as {
	parseHTML: (markup: string) => { document: Document; window: Window };
	Event: typeof globalThis.Event;
};

function keyEvent(key: string): Event {
	const event = new linkedom.Event("keydown", { cancelable: true }) as Event & {
		key: string;
	};
	event.key = key;
	return event;
}

function setup(overrides: { debounceMs?: number } = {}) {
	const { document } = linkedom.parseHTML(
		`<div>
			<input id="additional-tags" type="text" />
			<div id="selected-tags"></div>
			<ul id="tag-suggestions" role="listbox" hidden></ul>
		</div>`,
	);
	vi.stubGlobal("document", document);
	const input = document.getElementById("additional-tags") as HTMLInputElement;
	const chipList = document.getElementById("selected-tags") as HTMLElement;
	const suggestionList = document.getElementById(
		"tag-suggestions",
	) as HTMLElement;
	const fetchSuggestions = vi.fn(
		async (_query: string): Promise<string[]> => [],
	);
	const onTagsChanged = vi.fn((_tags: readonly string[]): void => undefined);
	const picker = createTagPicker({
		input,
		chipList,
		suggestionList,
		fetchSuggestions,
		onTagsChanged,
		debounceMs: overrides.debounceMs,
	});
	return {
		input,
		chipList,
		suggestionList,
		fetchSuggestions,
		onTagsChanged,
		picker,
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("committing free text", () => {
	it("commits a normalized chip on Enter and clears the input", () => {
		const { input, chipList, picker } = setup();
		input.value = " Research ";

		input.dispatchEvent(keyEvent("Enter"));

		expect(picker.getTags()).toEqual(["Research"]);
		expect(input.value).toBe("");
		expect(chipList.querySelector(".tag > span")?.textContent).toBe("Research");
	});

	it("commits on comma the same way", () => {
		const { input, picker } = setup();
		input.value = "#reading";

		input.dispatchEvent(keyEvent(","));

		expect(picker.getTags()).toEqual(["reading"]);
		expect(input.value).toBe("");
	});

	it("ignores a duplicate commit, keeping one chip", () => {
		const { input, chipList, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "research";

		input.dispatchEvent(keyEvent("Enter"));

		expect(picker.getTags()).toEqual(["research"]);
		expect(chipList.querySelectorAll(".tag")).toHaveLength(1);
	});
});

describe("chip removal", () => {
	it("removes a chip via its labelled remove button", () => {
		const { input, chipList, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		const removeButton =
			chipList.querySelector<HTMLButtonElement>(".tag-remove");
		expect(removeButton?.getAttribute("aria-label")).toBe(
			"Remove tag research",
		);

		removeButton?.dispatchEvent(new linkedom.Event("click"));

		expect(picker.getTags()).toEqual([]);
	});

	it("fires onTagsChanged on every add and remove", () => {
		const { input, chipList, onTagsChanged } = setup();

		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		expect(onTagsChanged).toHaveBeenLastCalledWith(["research"]);

		chipList
			.querySelector<HTMLButtonElement>(".tag-remove")
			?.dispatchEvent(new linkedom.Event("click"));
		expect(onTagsChanged).toHaveBeenLastCalledWith([]);
	});

	it("removes the last chip on Backspace when the input is empty", () => {
		const { input, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "reading";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "";

		input.dispatchEvent(keyEvent("Backspace"));

		expect(picker.getTags()).toEqual(["research"]);
	});

	it("leaves chips untouched on Backspace when the input has text", () => {
		const { input, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "still typing";

		input.dispatchEvent(keyEvent("Backspace"));

		expect(picker.getTags()).toEqual(["research"]);
	});
});

describe("suggestion fetching", () => {
	it("debounces 200ms and calls fetchSuggestions once with the settled query", async () => {
		vi.useFakeTimers();
		const { input, fetchSuggestions } = setup();
		input.value = "re";

		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(199);
		expect(fetchSuggestions).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(fetchSuggestions).toHaveBeenCalledTimes(1);
		expect(fetchSuggestions).toHaveBeenCalledWith("re");
	});

	it("respects a custom debounceMs", async () => {
		vi.useFakeTimers();
		const { input, fetchSuggestions } = setup({ debounceMs: 50 });
		input.value = "re";

		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(49);
		expect(fetchSuggestions).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(fetchSuggestions).toHaveBeenCalledTimes(1);
	});

	it("closes the list without fetching for an empty query", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, fetchSuggestions } = setup();
		input.value = "";

		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(500);

		expect(fetchSuggestions).not.toHaveBeenCalled();
		expect(suggestionList.hidden).toBe(true);
	});

	it("renders returned options and selects the active one with ArrowDown + Enter", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, picker, fetchSuggestions } = setup();
		fetchSuggestions.mockResolvedValue(["research", "reading"]);
		input.value = "re";

		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		await Promise.resolve();

		expect(suggestionList.hidden).toBe(false);
		expect(input.getAttribute("aria-expanded")).toBe("true");
		const options = suggestionList.querySelectorAll('[role="option"]');
		expect(options).toHaveLength(2);

		input.dispatchEvent(keyEvent("ArrowDown"));
		expect(input.getAttribute("aria-activedescendant")).toBe(
			"tag-suggestion-0",
		);
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		expect(options[1]?.getAttribute("aria-selected")).toBe("false");

		input.dispatchEvent(keyEvent("Enter"));

		expect(picker.getTags()).toEqual(["research"]);
		expect(suggestionList.hidden).toBe(true);
		expect(input.getAttribute("aria-expanded")).toBe("false");
	});

	it("closes the list on Escape without committing", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, picker, fetchSuggestions } = setup();
		fetchSuggestions.mockResolvedValue(["research"]);
		input.value = "re";
		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		await Promise.resolve();
		expect(suggestionList.hidden).toBe(false);

		input.dispatchEvent(keyEvent("Escape"));

		expect(suggestionList.hidden).toBe(true);
		expect(picker.getTags()).toEqual([]);
		expect(input.value).toBe("re");
	});

	it("commits an option on mousedown, preventing default so the input keeps focus", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, picker, fetchSuggestions } = setup();
		fetchSuggestions.mockResolvedValue(["research"]);
		input.value = "re";
		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		await Promise.resolve();

		const option = suggestionList.querySelector('[role="option"]');
		const mousedown = new linkedom.Event("mousedown", { cancelable: true });
		option?.dispatchEvent(mousedown);

		expect(mousedown.defaultPrevented).toBe(true);
		expect(picker.getTags()).toEqual(["research"]);
		expect(suggestionList.hidden).toBe(true);
	});

	it("closes the list silently on fetch rejection and keeps free entry working", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, picker, fetchSuggestions } = setup();
		fetchSuggestions.mockRejectedValueOnce(new Error("network error"));
		input.value = "re";
		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);
		await Promise.resolve();
		await Promise.resolve();

		expect(suggestionList.hidden).toBe(true);

		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		expect(picker.getTags()).toEqual(["research"]);
	});

	it("ignores an out-of-order resolution using a generation counter", async () => {
		vi.useFakeTimers();
		const { input, suggestionList, fetchSuggestions } = setup();
		let resolveFirst!: (value: string[]) => void;
		let resolveSecond!: (value: string[]) => void;
		fetchSuggestions
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveFirst = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSecond = resolve;
					}),
			);

		input.value = "r";
		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);

		input.value = "re";
		input.dispatchEvent(new linkedom.Event("input"));
		await vi.advanceTimersByTimeAsync(200);

		expect(fetchSuggestions).toHaveBeenCalledTimes(2);

		resolveSecond(["reading"]);
		await Promise.resolve();
		await Promise.resolve();

		resolveFirst(["rubbish"]);
		await Promise.resolve();
		await Promise.resolve();

		const options = suggestionList.querySelectorAll('[role="option"]');
		expect(options).toHaveLength(1);
		expect(options[0]?.textContent).toBe("reading");
	});
});

describe("disabled state", () => {
	it("disables the input and existing remove buttons", () => {
		const { input, chipList, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));

		picker.setDisabled(true);

		expect(input.disabled).toBe(true);
		expect(
			chipList.querySelector<HTMLButtonElement>(".tag-remove")?.disabled,
		).toBe(true);
	});

	it("disables remove buttons for chips rendered after setDisabled(true)", () => {
		const { input, chipList, picker } = setup();
		picker.setDisabled(true);

		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));

		expect(
			chipList.querySelector<HTMLButtonElement>(".tag-remove")?.disabled,
		).toBe(true);
	});
});

describe("setTags / addTag / commitInput", () => {
	it("replaces chips wholesale", () => {
		const { input, chipList, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));

		picker.setTags(["archive", "reading"]);

		expect(picker.getTags()).toEqual(["archive", "reading"]);
		expect(chipList.querySelectorAll(".tag")).toHaveLength(2);
	});

	it("adds a tag directly through addTag", () => {
		const { picker } = setup();

		picker.addTag("  #Reading ");

		expect(picker.getTags()).toEqual(["Reading"]);
	});

	it("commits chips already entered plus any uncommitted input text", () => {
		const { input, picker } = setup();
		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		input.value = "reading";

		picker.commitInput();

		expect(picker.getTags()).toEqual(["research", "reading"]);
		expect(input.value).toBe("");
	});

	it("splits a pasted comma-separated list into individual chips on commitInput()", () => {
		const { input, picker } = setup();
		input.value = "Research, reading";

		picker.commitInput();

		expect(picker.getTags()).toEqual(["Research", "reading"]);
		expect(input.value).toBe("");
	});
});

describe("destroy", () => {
	it("removes listeners and cancels a pending debounce timer", async () => {
		vi.useFakeTimers();
		const { input, fetchSuggestions, picker } = setup();
		input.value = "re";
		input.dispatchEvent(new linkedom.Event("input"));

		picker.destroy();
		await vi.advanceTimersByTimeAsync(500);

		expect(fetchSuggestions).not.toHaveBeenCalled();

		input.value = "research";
		input.dispatchEvent(keyEvent("Enter"));
		expect(picker.getTags()).toEqual([]);
	});
});
