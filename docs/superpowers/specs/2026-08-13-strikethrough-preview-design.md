# Strikethrough Preview Design

## Goal

Prevent the editor from presenting a complete single-tilde strikethrough before the user types the closing tilde.

## Current behavior and root cause

`tryAutoPair` treats `~` like `*` and `_` for a collapsed selection. Typing the opening `~` inserts `~~` and places the caret between them. The generated closer makes the source appear complete even though the user has not typed it. Later, an explicit `~` overtypes the generated closer and triggers the normal inline transform.

## Approved behavior

- At a collapsed caret, typing `~` inserts exactly one literal `~`.
- Text remains literal and unmarked until the user types a closing `~`.
- Typing the explicit closer in `~text~` applies the existing strikethrough transform.
- Typing `~` with a same-text-node selection continues to wrap the selected text.
- Overtype behavior for a pre-existing closing `~` remains available.
- Collapsed `*` and `_` auto-pairing remains unchanged.
- Code-block and inline-code exclusions remain unchanged.

## Implementation

Keep `~` in the supported marker set because selection wrapping still uses it. In `tryAutoPair`, reject `~` only in the collapsed-selection branch before paired text is inserted. No parser, serializer, renderer, schema, or keyboard-shortcut change is required.

## Verification

Two regression layers defend the contract:

1. Unit coverage for `tryAutoPair`: collapsed `~` returns `false`, leaves text unchanged, and leaves the caret unchanged; selected text still wraps.
2. `withAutoformat` integration coverage: typing `~hello` yields literal unmarked `~hello`, while the existing `~hello~` test continues to prove explicit-close conversion.

Focused tests must be observed failing before the production change, then passing afterward. Final repository gates are UI typecheck, lint, full UI tests, production build, and the Rust test suite required by repository policy.
