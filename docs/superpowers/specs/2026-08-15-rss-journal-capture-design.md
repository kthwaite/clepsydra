# RSS Journal Capture Design

## Goal

Let a reader preserve an RSS entry as editable Markdown in today’s journal without leaving the feed reader, while retaining a direct clipboard fallback.

## Scope

TSK-0064 changes the existing React feed-reader surface only. It reuses `useQuickCapture()` and the existing `POST /api/vault/journal/today/capture` contract; it does not add or change Rust, REST, OpenAPI, feed persistence, journal file format, or editor behavior.

The feature adds two actions for an entry with a safe HTTP(S) source URL:

- **Capture in journal** opens a compact inline Markdown composer.
- **Copy link** copies the same entry link as Markdown.

It does not automatically mark the entry read, bookmark it, copy its stored HTML, extract an excerpt, or navigate away after capture.

## Existing integration points

- `FeedReaderPane` already resolves an entry’s source URL through `safeFeedEntryUrl`, displays its title and actions, and owns entry-local mutation feedback.
- `useQuickCapture()` accepts a Markdown string, appends it to today’s journal, and invalidates the resulting page content.
- `useOpenTodayJournal()` opens or focuses today’s persisted page or draft path.
- `useCopyToClipboard()` owns clipboard capability detection, success/failure toasts, and transient copied state.

The implementation MUST reuse these hooks rather than adding a second journal or clipboard convention.

## Markdown representation

A pure helper constructs the shared Markdown link:

```ts
feedEntryMarkdownLink(title: string, url: string | null | undefined): string | null
```

The helper MUST:

- accept only URLs that `safeFeedEntryUrl` resolves to absolute `http:` or `https:` URLs;
- return `null` for absent, malformed, or non-HTTP(S) URLs;
- escape backslashes and square brackets in the title so the label remains one Markdown link;
- preserve the safe serialized URL returned by `safeFeedEntryUrl`;
- return `[escaped title](safe URL)` with no bullet or trailing whitespace.

The composer’s initial value is `- ${link}`. **Copy link** copies `${link}` without the bullet.

The draft is ordinary multiline Markdown. The UI sends the exact draft string after trimming only leading and trailing whitespace. Internal whitespace and line breaks remain byte-for-byte as entered. An empty or whitespace-only draft cannot be captured.

## Interaction design

### Actions

For a safe source URL, the existing reader action row includes:

1. **Open original**
2. **Capture in journal**
3. **Copy link**
4. the existing read, bookmark, and tag actions

For an absent or unsafe source URL, **Open original**, **Capture in journal**, and **Copy link** are unavailable. Existing read, bookmark, and tag actions remain available.

**Copy link** uses `useCopyToClipboard()`. Its visible and accessible label changes to **Copied** during the hook’s transient success state. Clipboard failure remains the shared hook’s error toast and MUST NOT open or alter the composer.

### Inline composer

Pressing **Capture in journal** opens one inline form immediately below the action row. It follows the existing tag editor’s visual language: a left accent rule, compact mono label, paper background, and the project’s existing button styles. It is not a modal or popover.

The form contains:

- a labelled multiline textarea named **Journal entry**;
- **Capture** submit action;
- **Cancel** action.

On open:

- initialize the draft to `- ${link}` for the currently rendered entry;
- move keyboard focus into the textarea;
- clear stale capture success/error feedback.

On Cancel:

- close the composer;
- discard the draft;
- issue no journal request.

While capture is pending:

- disable textarea, Capture, and Cancel;
- render the submit label as **Capturing…**;
- prevent duplicate requests.

Changing the selected entry resets and closes the composer, draft, and capture feedback. Feed-entry PATCH pending state does not disable journal or clipboard actions; journal capture pending state does not disable unrelated read/bookmark/tag actions.

## Capture settlement

Submit calls `useQuickCapture().mutateAsync(trimmedDraft)` exactly once.

On success:

- close and clear the composer;
- keep the feed reader and selected entry in place;
- expose a polite status message **Captured in today’s journal.**;
- expose **Open today’s journal**, wired through `useOpenTodayJournal()`;
- do not change feed read, bookmark, or tag state.

On failure:

- keep the composer open;
- preserve the exact untrimmed draft in the textarea;
- show a visible alert using the mutation’s concrete error message when available, with **Capture failed. Try again.** as fallback;
- allow the same draft to be retried.

Opening the composer again or selecting another entry clears the prior success state. **Open today’s journal** is available only after a successful capture for the currently selected entry.

## Accessibility

- Use React Aria `Button` for every action.
- The composer is a semantic form with a programmatically associated textarea label.
- Focus moves to the textarea only when the user opens the composer, never merely because an entry loads.
- Success uses `role="status"` with polite live announcement.
- Failure uses `role="alert"`.
- Disabled/pending behavior must be exposed through native textarea `disabled` and React Aria `isDisabled`.
- All actions remain keyboard operable and retain the existing focus-visible ring convention.

## Visual behavior

No new palette, typeface, dialog, or generic card component is introduced. The composer is a small annotation strip attached to the reader’s existing action boundary. Desktop and narrow/mobile layouts use the same wrapping action row and a full-width textarea; controls wrap rather than overflow.

## Error and edge behavior

- Unsafe/missing URL: link-derived actions are absent; no placeholder URL or title-only capture is generated.
- Clipboard unavailable or rejected: shared error toast; no local success state.
- Journal capture error: draft retained; no success status or journal navigation action.
- Empty draft: Capture disabled and form submission is a no-op.
- Entry change during an open or settled composer: local capture state resets before the new entry can be captured.
- Repeated successful capture is allowed only through an explicit new composer submission; no deduplication is inferred.

## Documentation

Update `ui/src/docs/content/capture-feeds-and-archives.mdx` in the private-feed workflow to document:

- **Capture in journal** opens an editable Markdown draft and appends it to today’s journal;
- **Copy link** copies the entry as Markdown;
- capture does not alter read/bookmark state or include the stored article body.

## Testing and verification

### Unit/component contracts

- formatter accepts HTTP(S), rejects absent/malformed/unsafe URLs, and escapes title backslashes/brackets;
- Copy link sends exact Markdown to the shared clipboard hook and reflects Copied state;
- composer opens with the exact bullet link and receives focus;
- edited multiline Markdown is trimmed only at its edges and submitted exactly once;
- empty draft cannot submit;
- pending state disables only composer controls and prevents duplicate capture;
- success closes the form, leaves reader state unchanged, announces completion, and opens today’s journal only on request;
- failure preserves the draft and supports retry;
- Cancel and selected-entry changes clear local composer state without requests;
- unsafe URLs expose none of the three link-derived actions.

### Browser smoke

With a fixture feed entry:

1. Open `/feeds` and select an entry with a safe source URL.
2. Copy link and observe **Copied**.
3. Open **Capture in journal**, edit the Markdown, and submit.
4. Verify the reader remains selected and announces success.
5. Open today’s journal from the success action and verify the captured Markdown appears.
6. At narrow viewport width, verify the action row and composer remain reachable without horizontal overflow.

## Acceptance criteria

- A safe RSS entry can be captured directly into today’s journal from an editable inline Markdown composer.
- Capture stays in the reader, preserves feed read/bookmark/tag state, and offers an explicit route to today’s journal after success.
- Copy Link copies the escaped Markdown link through the established clipboard behavior.
- Unsafe or absent entry URLs do not produce capture or clipboard actions.
- Capture failures retain the draft and are retryable.
- Existing journal API, feed API, and backend contracts remain unchanged.
