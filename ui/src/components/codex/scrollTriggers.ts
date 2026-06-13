/**
 * Pure trigger-point math for the folio scrollspy.
 *
 * Headings near the document end can never rise above the activation
 * threshold — the container hits maxScroll first — so their natural trigger
 * positions are unreachable and they could never become active. Instead of
 * padding the page or moving the threshold, unreachable triggers are uplifted
 * onto the scrollable range with a delayed smoothstep (after
 * https://thirty-five.com/blog/overengineered-anchoring/): triggers in the
 * early document keep their natural position, the uplift eases in past
 * SMOOTHSTEP_DELAY, and the last trigger lands exactly on maxScroll.
 *
 * Jump targets are computed from the same trigger map so that
 * `activeIndexAt(jumpTargetFor(i)) === i` holds for every heading — the entry
 * you click is always the entry that lights up.
 */

/** px below the container top within which a heading counts as "current" */
export const SCROLLSPY_THRESHOLD = 96;
/** px of breathing room above a heading when jumping to it */
export const JUMP_OFFSET = 16;
/** normalized document position at which trigger uplift begins */
const SMOOTHSTEP_DELAY = 0.4;
/** scrollTop within this many px of maxScroll counts as "at the bottom" */
const BOTTOM_EPSILON = 1;

/**
 * Maps heading offsets (px from the top of the scroll content) to the
 * scrollTop at which each heading becomes active. Triggers are strictly
 * increasing and never exceed maxScroll, so every heading owns a reachable,
 * non-empty band of scroll positions.
 */
export function computeTriggers(
  headingTops: number[],
  maxScroll: number,
  threshold = SCROLLSPY_THRESHOLD,
): number[] {
  const n = headingTops.length;
  if (n === 0) return [];
  const triggers = headingTops.map((top) => top - threshold);
  const last = triggers[n - 1];
  const overflow = maxScroll > 0 ? Math.max(0, last - maxScroll) : 0;
  if (overflow > 0 && last > 0) {
    for (let i = 0; i < n; i++) {
      const x = triggers[i] / last;
      const t = clamp((x - SMOOTHSTEP_DELAY) / (1 - SMOOTHSTEP_DELAY), 0, 1);
      triggers[i] -= overflow * t * t * (3 - 2 * t);
    }
    // smoothstep can collide triggers when headings cluster tightly; restore
    // strict order, pin the last trigger to maxScroll, and re-cap beneath it
    for (let i = 1; i < n; i++) {
      triggers[i] = Math.max(triggers[i], triggers[i - 1] + 1);
    }
    triggers[n - 1] = Math.min(triggers[n - 1], maxScroll);
    for (let i = n - 2; i >= 0; i--) {
      triggers[i] = Math.min(triggers[i], triggers[i + 1] - 1);
    }
  }
  return triggers.map((t) => Math.max(0, t));
}

/** Index of the heading active at the given scrollTop. */
export function activeIndexAt(
  scrollTop: number,
  triggers: number[],
  maxScroll: number,
): number {
  const n = triggers.length;
  if (n === 0) return 0;
  // browsers clamp scrollTop fractionally short of maxScroll on scaled
  // displays; treat anything within epsilon of the bottom as the end
  if (maxScroll > 0 && scrollTop >= maxScroll - BOTTOM_EPSILON) return n - 1;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    if (triggers[i] <= scrollTop) idx = i;
    else break;
  }
  return idx;
}

/**
 * scrollTop to jump to for a heading: as close to `headingTop - offset` as
 * possible while staying inside the heading's own trigger band, so the
 * clicked heading is the one that ends up highlighted.
 */
export function jumpTargetFor(
  index: number,
  headingTops: number[],
  triggers: number[],
  maxScroll: number,
  offset = JUMP_OFFSET,
): number {
  const n = headingTops.length;
  if (n === 0 || index < 0 || index >= n) return 0;
  const desired = headingTops[index] - offset;
  const lower = triggers[index];
  // the band below the last heading must also stay clear of the bottom
  // epsilon, which hands the active index to the final heading
  const upper =
    index === n - 1
      ? maxScroll
      : Math.min(triggers[index + 1], maxScroll - BOTTOM_EPSILON) - 1;
  return Math.max(0, Math.min(Math.max(desired, lower), upper));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
