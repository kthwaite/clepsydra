# Task 7 Report: Search Experience

## Status

IMPLEMENTED. Search model, safe snippet parsing, SwiftUI search states/results, connected-vault routing, focused tests, package tests, and Xcode project checks are complete.

## Commit

`85d554b` — `feat(ios): add vault search`

## Files changed

- `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Search/SearchModel.swift`
- `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraCore/Search/SearchSnippet.swift`
- `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchView.swift`
- `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/Search/SearchResultRow.swift`
- `ios/Packages/ClepsydraMobileKit/Sources/ClepsydraUI/AppRootView.swift`
- `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/SearchModelTests.swift`
- `ios/Packages/ClepsydraMobileKit/Tests/ClepsydraCoreTests/SearchSnippetTests.swift`

## TDD evidence

### RED: search types absent

Commands:

```text
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchSnippetTests
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchModelTests
```

Observed before implementation:

```text
error: cannot find 'SearchSnippet' in scope
error: cannot find 'SearchModel' in scope
```

The failures were caused by the missing production search types.

### GREEN: focused parser tests

Command:

```text
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchSnippetTests
```

Observed:

```text
Test Suite 'SearchSnippetTests' passed
Executed 4 tests, with 0 failures (0 unexpected)
```

Coverage includes exact marker parsing, literal HTML-like text, unmatched opening markers, and unmatched closing markers.

### GREEN: focused model tests

Command:

```text
swift test --package-path ios/Packages/ClepsydraMobileKit --filter SearchModelTests
```

Observed:

```text
Test Suite 'SearchModelTests' passed
Executed 4 tests, with 0 failures (0 unexpected)
```

Coverage includes 250 ms injected debounce, stale-result suppression after cancellation, whitespace idle/no-call behavior, failed search query preservation and immediate retry, and an empty loaded result set.

### GREEN: full Swift package tests

Command:

```text
swift test --package-path ios/Packages/ClepsydraMobileKit
```

Observed:

```text
Test Suite 'ClepsydraMobileKitPackageTests.xctest' passed
Executed 44 tests, with 0 failures (0 unexpected)
```

### GREEN: project generation and scheme list

Commands:

```text
xcodegen generate --spec ios/project.yml
xcodebuild -list -project ios/ClepsydraMobile.xcodeproj
```

Observed: project generation succeeded. Schemes listed were `ClepsydraCore`, `ClepsydraMobile`, and `ClepsydraUI`.

### iOS target build check

Command:

```text
xcodebuild -project ios/ClepsydraMobile.xcodeproj -scheme ClepsydraMobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Observed:

```text
xcodebuild: error: Unable to find a destination matching the provided destination specifier
Ineligible destinations ... error:iOS 26.2 is not installed.
```

## Implementation and self-review

- `SearchViewModel` is `@MainActor @Observable`, owns one injected `VaultAPI`, exposes idle/loading/loaded/failed phases, and provides `SearchModel` compatibility naming.
- Query updates cancel the previous task, use an injected sleeper for exactly 250 ms, call `search(query:limit: 20)`, and require both task cancellation and generation identity checks before publishing results/errors.
- Empty and whitespace-only queries return to idle without making an API call. Retry preserves the query and skips the debounce.
- Snippet parsing recognizes only exact `<mark>` and `</mark>` pairs; unmatched markers and unrelated HTML-like text remain literal. The row renders parsed segments through `AttributedString`, not HTML or Markdown.
- `SearchView` uses `.searchable`, explicit idle/loading/no-results/error states, Retry, title fallback to path, result selection via `openPage(UUID)`, and New Note via `createPage()`.
- `ConnectedVaultView` passes the active `session.api` into `SearchView`, retains its query binding, keeps Disconnect on the same `VaultSession`, and routes selected IDs to a reader placeholder that fetches the page through that same session-owned API.
- Existing AppRoot/session ownership remains single-source; no duplicate client or session state was introduced.
- No reader/editor implementation or unrelated files were added.

## Concerns

- The generic iOS Simulator build is environment-blocked because this workstation has no installed iOS 26.2 simulator runtime. Swift package tests/build and Xcode project generation/list checks passed; simulator UI behavior was not exercised.
- The New Note action intentionally routes to the requested placeholder because reader/editor scope is excluded from Task 7.

## Review follow-up

### RED: navigation destination placement

Review identified that `navigationDestination(item:)` was attached outside the `NavigationStack` content. That placement can prevent selected search results from pushing the reader destination.

### GREEN: focused UI regression/build coverage

The destination modifier now lives on the `Group` inside `NavigationStack`, while the destination still receives the same `VaultSession` and selected page ID. The focused UI package tests passed:

```text
swift test --package-path ios/Packages/ClepsydraMobileKit --filter ClepsydraUITests
Test Suite 'ClepsydraMobileKitPackageTests.xctest' passed
Executed 12 tests, with 0 failures (0 unexpected)
```

`AppRootViewTests.testRootViewAcceptsOneInjectedSessionForSetupAndConnectedStates` continues to compile and construct the connected route with one injected session, providing compile-level coverage for the corrected navigation composition.
