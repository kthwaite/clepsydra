# Sunrise Rollover Design

## Goal

Make the Atrium Sky card show the sunrise associated with the current night. During daylight and before sunset, it shows the current local date's sunrise. From sunset until local midnight, it shows the next local date's sunrise and identifies it as tomorrow. After midnight, that same upcoming sunrise belongs to the current date, so the indicator disappears.

## Behavior contract

- Before today's sunset, Sunrise shows today's sunrise time with no indicator.
- At exactly today's sunset and through 23:59:59 local time, Sunrise shows tomorrow's sunrise time followed by `(tomorrow)` in the Sky card key/value row.
- At local midnight, the current date advances. Sunrise continues to show the upcoming sunrise for the new current date, but `(tomorrow)` is removed.
- The compact sunrise tick below the day arc shows the selected sunrise time but never the `(tomorrow)` indicator.
- Sunset, Light left, and the day arc's position continue to use the current local date's sunrise and sunset. The feature does not reinterpret those values after sunset.
- When no location is configured, the existing disabled placeholder card follows the same date-selection behavior using its synthetic 06:00 sunrise and 20:00 sunset.

All date changes use the browser's local calendar operations. Advancing to tomorrow means incrementing the local date, not adding a fixed 24-hour duration, so daylight-saving transitions remain correct.

## Architecture

Add a small pure selector to `ui/src/components/codex/sky.ts`. It receives the current time, today's sunrise and sunset, and tomorrow's sunrise. It returns the sunrise to display plus whether the row needs the tomorrow indicator. The boundary is `now >= todaySunset`.

`Atrium.tsx` remains responsible for obtaining astronomical times from SunCalc. It computes today's times as it does now and obtains tomorrow's times for the selector. The existing sun arc, sunset, and remaining-light calculations stay based on today's times. The selected sunrise is formatted into the existing `SkyData` object together with a new boolean indicator field.

`SkyCard.tsx` owns presentation. It appends `(tomorrow)` to the Sunrise row only when the indicator field is true. `DayArc` continues to receive the selected formatted time without indicator text.

## Data flow

1. `useClock` supplies the current browser-local time.
2. `Atrium` obtains today's sunrise and sunset for the configured coordinates, or the existing synthetic defaults.
3. `Atrium` creates tomorrow by incrementing a copy of `now` with local `setDate` and obtains that date's sunrise.
4. The pure selector chooses today's sunrise before sunset and tomorrow's sunrise at or after sunset.
5. `Atrium` formats the selected sunrise and passes its tomorrow status to `SkyCard`.
6. At midnight, `useClock` triggers recomputation against the new local date, naturally clearing the indicator while retaining the upcoming sunrise time.

## Error behavior

SunCalc and the placeholder path preserve their existing behavior. This change adds no new I/O or user-visible error state. Invalid location-derived dates are outside this feature's scope and continue through the existing formatting path.

## Tests

Behavioral tests will cover:

- selection of today's sunrise immediately before sunset;
- selection of tomorrow's sunrise at exactly sunset;
- selection of tomorrow's sunrise after sunset;
- selection of the new current date's sunrise without an indicator after midnight;
- local-calendar tomorrow construction across a daylight-saving boundary;
- rendering `(tomorrow)` in the Sunrise key/value row when requested;
- omitting the indicator from the day-arc tick and from ordinary Sunrise rows.

The UI smoke test will exercise the front page with a fixed clock and deterministic sun times on both sides of sunset, confirming the displayed time and indicator.