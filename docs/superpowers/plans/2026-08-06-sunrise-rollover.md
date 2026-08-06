# Sunrise Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the next local date's sunrise after sunset, with `(tomorrow)` only in the Sky card Sunrise row before midnight.

**Architecture:** Add a lazy, pure sunrise selector and a local-calendar next-day helper in `sky.ts`. `Atrium` keeps today's sun times for the arc, sunset, and light-left, while formatting the selector's sunrise into `SkyData`; `SkyCard` owns the row-only indicator.

**Tech Stack:** TypeScript 5.9, React 19, SunCalc 1.9, Vitest 4, Testing Library, Biome

## Global Constraints

- The switch boundary is `now >= todaySunset`.
- Before sunset, use the current local date's sunrise without an indicator.
- From sunset until local midnight, use the next local date's sunrise with `(tomorrow)` in the Sunrise key/value row only.
- After midnight, use the new current date's sunrise without an indicator.
- The day-arc sunrise tick uses the selected time but never indicator text.
- Sunset, Light left, and day-arc position remain based on the current local date's sun times.
- Construct the next date with local calendar arithmetic, not a fixed 24-hour duration.
- Preserve the synthetic 06:00/20:00 behavior when no location is configured.
- Add no dependency and no unrelated refactor.

---

### Task 1: Sunrise selection and row indicator

**Files:**
- Modify: `ui/src/components/codex/sky.ts`
- Modify: `ui/src/components/codex/sky.test.ts`
- Modify: `ui/src/components/codex/Atrium.tsx:95-116`
- Modify: `ui/src/components/codex/SkyCard.tsx:8-16,53-71`
- Modify: `ui/src/components/codex/__tests__/SkyCard.test.tsx`

**Interfaces:**
- Consumes: existing `SunCalc.getTimes(date, latitude, longitude)`, `fmtTime(Date)`, `atHour(Date, hour)`, and `SkyData` flow from `Atrium` to `SkyCard`.
- Produces: `nextLocalDate(date: Date): Date`; `selectDisplayedSunrise(now: Date, todaySunrise: Date, todaySunset: Date, tomorrowSunrise: () => Date): { time: Date; isTomorrow: boolean }`; `SkyData.sunriseIsTomorrow: boolean`.

- [ ] **Step 1: Write failing selector and local-calendar tests**

In `ui/src/components/codex/sky.test.ts`, import `nextLocalDate` and `selectDisplayedSunrise`, then add tests equivalent to:

```ts
describe("selectDisplayedSunrise", () => {
  const todaySunrise = new Date("2026-05-02T05:54:00Z");
  const todaySunset = new Date("2026-05-02T20:31:00Z");
  const tomorrowSunrise = new Date("2026-05-03T05:52:00Z");

  it("keeps today's sunrise before sunset without evaluating tomorrow", () => {
    const getTomorrow = vi.fn(() => tomorrowSunrise);
    expect(
      selectDisplayedSunrise(
        new Date("2026-05-02T20:30:59Z"),
        todaySunrise,
        todaySunset,
        getTomorrow,
      ),
    ).toEqual({ time: todaySunrise, isTomorrow: false });
    expect(getTomorrow).not.toHaveBeenCalled();
  });

  it.each([
    "2026-05-02T20:31:00Z",
    "2026-05-02T23:59:59Z",
  ])("uses tomorrow's sunrise at and after sunset (%s)", (now) => {
    expect(
      selectDisplayedSunrise(
        new Date(now),
        todaySunrise,
        todaySunset,
        () => tomorrowSunrise,
      ),
    ).toEqual({ time: tomorrowSunrise, isTomorrow: true });
  });

  it("uses the new current date's sunrise without an indicator after midnight", () => {
    const currentSunrise = new Date("2026-05-03T05:52:00Z");
    expect(
      selectDisplayedSunrise(
        new Date("2026-05-03T00:00:00Z"),
        currentSunrise,
        new Date("2026-05-03T20:33:00Z"),
        () => new Date("2026-05-04T05:50:00Z"),
      ),
    ).toEqual({ time: currentSunrise, isTomorrow: false });
  });
});

describe("nextLocalDate", () => {
  it("increments the local calendar date while retaining local clock fields", () => {
    const source = new Date(2026, 2, 8, 12, 34, 56, 789);
    const next = nextLocalDate(source);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(9);
    expect(next.getHours()).toBe(12);
    expect(next.getMinutes()).toBe(34);
    expect(next.getSeconds()).toBe(56);
    expect(next.getMilliseconds()).toBe(789);
    expect(source.getDate()).toBe(8);
  });
});
```

Add `vi` to the existing Vitest import.

- [ ] **Step 2: Run the focused helper test and verify RED**

Run: `bun --cwd ui test -- src/components/codex/sky.test.ts`

Expected: FAIL because `nextLocalDate` and `selectDisplayedSunrise` are not exported by `sky.ts`.

- [ ] **Step 3: Implement the minimal lazy selector**

Add to `ui/src/components/codex/sky.ts`:

```ts
export function nextLocalDate(date: Date): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
}

export function selectDisplayedSunrise(
  now: Date,
  todaySunrise: Date,
  todaySunset: Date,
  tomorrowSunrise: () => Date,
): { time: Date; isTomorrow: boolean } {
  if (now.getTime() >= todaySunset.getTime()) {
    return { time: tomorrowSunrise(), isTomorrow: true };
  }
  return { time: todaySunrise, isTomorrow: false };
}
```

Keep the helper independent of SunCalc. Laziness avoids a second astronomical calculation every second before sunset.

- [ ] **Step 4: Run the focused helper test and verify GREEN**

Run: `bun --cwd ui test -- src/components/codex/sky.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing SkyCard indicator test**

In `ui/src/components/codex/__tests__/SkyCard.test.tsx`, add `sunriseIsTomorrow: false` to `makeSky`. Add:

```tsx
it("marks only the Sunrise row as tomorrow", () => {
  render(
    <SkyCard
      sky={makeSky({ sunriseIsTomorrow: true })}
      hasLocation={true}
      onEdit={vi.fn()}
    />,
  );

  expect(screen.getByText("06:12 (tomorrow)")).toBeInTheDocument();
  expect(screen.getAllByText(/tomorrow/i)).toHaveLength(1);
  expect(screen.getByText("↑ 06:12")).toBeInTheDocument();
});
```

The exact day-arc assertion may use its existing text node representation if Testing Library normalizes the arrow separately; it must establish that the compact tick remains time-only.

- [ ] **Step 6: Run the focused component test and verify RED**

Run: `bun --cwd ui test -- src/components/codex/__tests__/SkyCard.test.tsx`

Expected: FAIL because `SkyData` lacks `sunriseIsTomorrow` and the card does not render `(tomorrow)`.

- [ ] **Step 7: Wire selection through Atrium and render the row-only indicator**

Update `SkyData`:

```ts
sunrise: string;
sunriseIsTomorrow: boolean;
```

In `SkyCard`, keep `sky.sunrise` unchanged for `DayArc`. For the key/value row only, pass:

```tsx
<KVLine
  k="Sunrise"
  v={`${sky.sunrise}${sky.sunriseIsTomorrow ? " (tomorrow)" : ""}`}
/>
```

Import `nextLocalDate` and `selectDisplayedSunrise` in `Atrium.tsx`. Inside the existing sky memo, centralize the current location/default choice as a local `getSunTimes(date: Date)` function, calculate `times = getSunTimes(now)`, then select lazily:

```ts
const displayedSunrise = selectDisplayedSunrise(
  now,
  times.sunrise,
  times.sunset,
  () => getSunTimes(nextLocalDate(now)).sunrise,
);
```

Return:

```ts
sunrise: fmtTime(displayedSunrise.time),
sunriseIsTomorrow: displayedSunrise.isTomorrow,
```

Do not replace `times.sunrise` or `times.sunset` in `sunArcPosition`, remaining-light, or sunset formatting.

- [ ] **Step 8: Run both focused tests and verify GREEN**

Run: `bun --cwd ui test -- src/components/codex/sky.test.ts src/components/codex/__tests__/SkyCard.test.tsx`

Expected: PASS.

- [ ] **Step 9: Format changed UI files**

Run: `bunx --cwd ui biome check --write src/components/codex/sky.ts src/components/codex/sky.test.ts src/components/codex/Atrium.tsx src/components/codex/SkyCard.tsx src/components/codex/__tests__/SkyCard.test.tsx`

Expected: exits 0 and changes only formatting/import order in the listed files.

- [ ] **Step 10: Commit the implementation**

```bash
git add ui/src/components/codex/sky.ts ui/src/components/codex/sky.test.ts ui/src/components/codex/Atrium.tsx ui/src/components/codex/SkyCard.tsx ui/src/components/codex/__tests__/SkyCard.test.tsx
git commit -m "fix(ui): show tomorrow's sunrise after sunset"
```

### Task 2: Verification and front-page smoke test

**Files:**
- Verify only; modify a changed file only if a gate reveals a defect in this feature.

**Interfaces:**
- Consumes: the completed sunrise selection and `SkyData.sunriseIsTomorrow` contract from Task 1.
- Produces: evidence that the focused behavior, complete UI suite, typecheck, lint, build, and rendered front page all work.

- [ ] **Step 1: Run the complete UI test suite**

Run: `bun --cwd ui test`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun --cwd ui typecheck`

Expected: exits 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run lint**

Run: `bun --cwd ui lint`

Expected: exits 0 with no Biome diagnostics.

- [ ] **Step 4: Run the production build**

Run: `bun --cwd ui build`

Expected: exits 0 and emits the Vite production bundle.

- [ ] **Step 5: Smoke-test the rendered front page**

Start Vite with `bun --cwd ui dev --host 127.0.0.1 --port 4173`. Open two browser tabs at `about:blank`, set Puppeteer's timezone to `Europe/London`, and install a pre-navigation `Date` override in each tab: `2026-08-06T12:00:00+01:00` for the before-sunset tab and `2026-08-06T23:00:00+01:00` for the after-sunset tab. Intercept `GET /api/vault/location` in each navigation and respond with `{\"latitude\":51.5074,\"longitude\":-0.1278,\"label\":\"London\"}`; allow other requests to continue. Navigate both tabs to `http://127.0.0.1:4173/`. In the noon tab, observe that the Sunrise row has no `(tomorrow)`. In the 23:00 tab, use DOM text assertions to confirm the Sunrise row contains `(tomorrow)` exactly once, record its time, and confirm the `DayArc` label contains that same time without `(tomorrow)`. The focused selector tests supply the exact-sunset boundary proof.

- [ ] **Step 6: Commit any verification-only correction**

If Step 1-5 required a feature correction, stage the complete feature file set (unchanged files are ignored) and commit:

```bash
git add ui/src/components/codex/sky.ts ui/src/components/codex/sky.test.ts ui/src/components/codex/Atrium.tsx ui/src/components/codex/SkyCard.tsx ui/src/components/codex/__tests__/SkyCard.test.tsx
git commit -m "fix(ui): correct sunrise rollover verification"
```

If no correction was required, create no empty commit.