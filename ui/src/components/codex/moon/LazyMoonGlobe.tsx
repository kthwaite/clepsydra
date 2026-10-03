import { lazy, Suspense } from "react";
import type { MoonGlobeProps } from "./MoonGlobe";

const MoonGlobe = lazy(() => import("./MoonGlobe"));

/** `MoonGlobe` in its own chunk, so three.js loads only when shown. */
export function LazyMoonGlobe(props: MoonGlobeProps) {
  return (
    <Suspense fallback={props.fallback}>
      <MoonGlobe {...props} />
    </Suspense>
  );
}
