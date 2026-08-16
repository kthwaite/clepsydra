import { normalizeCaptureTags } from "#/lib/capture-tags";

export interface TagPickerOptions {
	input: HTMLInputElement;
	chipList: HTMLElement;
	suggestionList: HTMLElement; // <ul role="listbox">
	fetchSuggestions: (query: string) => Promise<string[]>;
	onTagsChanged?: (tags: readonly string[]) => void;
	debounceMs?: number; // default 200
}

export interface TagPicker {
	getTags(): string[];
	setTags(tags: readonly string[]): void;
	addTag(tag: string): void;
	commitInput(): void;
	setDisabled(disabled: boolean): void;
	destroy(): void;
}

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Chip-based tag input backed by a debounced suggestion fetch. Kept
 * framework-free to match the rest of the popup; every DOM element it
 * touches is either a caller-supplied root (`input`/`chipList`/
 * `suggestionList`) or created fresh on each render, so nothing here
 * assumes more than `document.createElement` + basic Element methods
 * (no `querySelector`, no `document.createTextNode`) — the popup's own
 * test harness stands in a minimal DOM stub that doesn't implement those.
 */
export function createTagPicker(options: TagPickerOptions): TagPicker {
	const { input, chipList, suggestionList, fetchSuggestions, onTagsChanged } =
		options;
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	let tags: string[] = [];
	let disabled = false;
	let removeButtons: HTMLButtonElement[] = [];
	let suggestions: string[] = [];
	let optionElements: HTMLLIElement[] = [];
	let activeIndex = -1;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let fetchGeneration = 0;

	const notify = (): void => {
		onTagsChanged?.(tags.slice());
	};

	const renderChips = (): void => {
		chipList.replaceChildren();
		removeButtons = [];
		for (const tag of tags) {
			const chip = document.createElement("span");
			chip.className = "tag";

			const label = document.createElement("span");
			label.textContent = tag;
			chip.append(label);

			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "tag-remove";
			remove.setAttribute("aria-label", `Remove tag ${tag}`);
			remove.textContent = "×";
			remove.disabled = disabled;
			remove.addEventListener("click", () => {
				removeTag(tag);
			});
			chip.append(remove);
			removeButtons.push(remove);

			chipList.append(chip);
		}
	};

	const removeTag = (tag: string): void => {
		const index = tags.indexOf(tag);
		if (index === -1) return;
		tags.splice(index, 1);
		renderChips();
		notify();
	};

	const addNormalized = (raw: string): void => {
		if (disabled) return;
		const [normalized] = normalizeCaptureTags([raw]);
		if (!normalized || tags.includes(normalized)) return;
		tags.push(normalized);
		renderChips();
		notify();
	};

	// Free text (typed or pasted) may itself contain commas — e.g. pasting
	// the placeholder's own "research, reading" — so it's split and
	// normalized as a batch, unlike a single selected suggestion.
	const addAllNormalized = (raw: string): void => {
		if (disabled) return;
		const normalized = normalizeCaptureTags(raw.split(","));
		let changed = false;
		for (const tag of normalized) {
			if (tags.includes(tag)) continue;
			tags.push(tag);
			changed = true;
		}
		if (changed) {
			renderChips();
			notify();
		}
	};

	const closeList = (): void => {
		suggestions = [];
		optionElements = [];
		activeIndex = -1;
		suggestionList.replaceChildren();
		suggestionList.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
	};

	const setActiveIndex = (index: number): void => {
		activeIndex = index;
		optionElements.forEach((option, i) => {
			option.setAttribute("aria-selected", i === index ? "true" : "false");
		});
		if (index >= 0 && index < suggestions.length) {
			input.setAttribute("aria-activedescendant", `tag-suggestion-${index}`);
		} else {
			input.removeAttribute("aria-activedescendant");
		}
	};

	const renderSuggestions = (items: string[]): void => {
		if (items.length === 0) {
			closeList();
			return;
		}
		suggestions = items;
		activeIndex = -1;
		suggestionList.replaceChildren();
		optionElements = items.map((tag, i) => {
			const option = document.createElement("li");
			option.setAttribute("id", `tag-suggestion-${i}`);
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", "false");
			option.textContent = tag;
			option.addEventListener("mousedown", (event) => {
				event.preventDefault();
				commitOption(tag);
			});
			suggestionList.append(option);
			return option;
		});
		suggestionList.hidden = false;
		input.setAttribute("aria-expanded", "true");
		input.removeAttribute("aria-activedescendant");
	};

	// Commits a single, already-known suggestion (never contains a comma).
	const commitOption = (tag: string): void => {
		addNormalized(tag);
		input.value = "";
		closeList();
	};

	// Commits whatever the user typed or pasted, which may be a
	// comma-separated list.
	const commitFreeText = (raw: string): void => {
		addAllNormalized(raw);
		input.value = "";
		closeList();
	};

	const runFetch = (query: string): void => {
		const generation = ++fetchGeneration;
		fetchSuggestions(query)
			.then((items) => {
				if (generation !== fetchGeneration) return;
				renderSuggestions(items);
			})
			.catch(() => {
				if (generation !== fetchGeneration) return;
				closeList();
			});
	};

	const scheduleFetch = (query: string): void => {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		if (query.trim() === "") {
			closeList();
			return;
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			runFetch(query);
		}, debounceMs);
	};

	const onInput = (): void => {
		scheduleFetch(input.value);
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		switch (event.key) {
			case "Enter": {
				event.preventDefault();
				if (activeIndex >= 0 && activeIndex < suggestions.length) {
					commitOption(suggestions[activeIndex]);
				} else {
					commitFreeText(input.value);
				}
				return;
			}
			case ",": {
				event.preventDefault();
				commitFreeText(input.value);
				return;
			}
			case "ArrowDown": {
				if (suggestions.length === 0) return;
				event.preventDefault();
				setActiveIndex(Math.min(activeIndex + 1, suggestions.length - 1));
				return;
			}
			case "ArrowUp": {
				if (suggestions.length === 0) return;
				event.preventDefault();
				setActiveIndex(Math.max(activeIndex - 1, 0));
				return;
			}
			case "Escape": {
				if (suggestions.length === 0) return;
				// The popup's default Escape action closes the whole action popup;
				// without this the list closing is invisible because the popup
				// vanishes with it, taking any uncommitted chips along.
				event.preventDefault();
				closeList();
				return;
			}
			case "Backspace": {
				if (input.value === "" && tags.length > 0) {
					removeTag(tags[tags.length - 1]);
				}
				return;
			}
			default:
				return;
		}
	};

	input.addEventListener("input", onInput);
	input.addEventListener("keydown", onKeyDown);
	closeList();

	return {
		getTags(): string[] {
			return tags.slice();
		},
		setTags(newTags: readonly string[]): void {
			// The polling loop calls this every 250ms with the same
			// server-reported tags for the duration of a capture, and
			// `#selected-tags` is an `aria-live` region — re-rendering it on no
			// actual change would re-announce the same list to a screen reader
			// several times a second.
			const next = normalizeCaptureTags(newTags);
			if (
				tags.length === next.length &&
				tags.every((tag, i) => tag === next[i])
			) {
				return;
			}
			tags = next;
			renderChips();
			notify();
		},
		addTag(tag: string): void {
			addNormalized(tag);
		},
		commitInput(): void {
			commitFreeText(input.value);
		},
		setDisabled(value: boolean): void {
			disabled = value;
			input.disabled = value;
			for (const button of removeButtons) button.disabled = value;
			// An already-open list would otherwise stay visible over a disabled
			// combobox, and its mousedown handlers don't check `disabled`.
			if (value) closeList();
		},
		destroy(): void {
			if (debounceTimer !== undefined) clearTimeout(debounceTimer);
			debounceTimer = undefined;
			// Invalidate any in-flight fetch so a late resolution can't mutate
			// torn-down DOM — same generation-counter guard runFetch's
			// callbacks already check.
			fetchGeneration += 1;
			input.removeEventListener("input", onInput);
			input.removeEventListener("keydown", onKeyDown);
		},
	};
}
