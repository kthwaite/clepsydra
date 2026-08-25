import { createContext, type ReactNode, useContext } from "react";
import {
  DISABLED_FEATURES,
  type FeatureFlags,
  useFeatures,
} from "#/api/features";

const FeatureFlagsContext = createContext<FeatureFlags | null>(null);

export function useFeatureFlags(): FeatureFlags {
  const features = useContext(FeatureFlagsContext);
  if (!features) {
    throw new Error("useFeatureFlags must be used within FeatureFlagsProvider");
  }
  return features;
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const featuresQuery = useFeatures();

  if (featuresQuery.isPending) {
    return (
      <div
        role="status"
        aria-label="Loading features"
        className="flex min-h-dvh items-center justify-center bg-paper"
      >
        <span className="cl-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ink-mute)]">
          Loading features…
        </span>
      </div>
    );
  }

  const features =
    featuresQuery.isError || !featuresQuery.data
      ? DISABLED_FEATURES
      : featuresQuery.data;

  return (
    <FeatureFlagsContext.Provider value={features}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}
