/** The one keyboard-focus cue for Stone & Lamp controls: a 2px cobalt ring,
 *  offset on the page ground so it reads on sink and raise fills too. */
export const FOCUS_RING =
  "outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent data-[focus-visible]:ring-offset-2 data-[focus-visible]:ring-offset-ground";

/** Same ring for plain elements (no React Aria focus attributes). */
export const FOCUS_RING_NATIVE =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ground";
