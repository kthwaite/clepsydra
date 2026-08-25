import { $api } from "#/api/client";
import type { components } from "#/api/schema";

export const DISABLED_FEATURES = {
  academic: false,
  feeds: false,
} as const;

export type FeatureFlags = components["schemas"]["FeatureFlagsResponse"];
export type FeatureName = keyof FeatureFlags;

export function useFeatures() {
  return $api.useQuery("get", "/api/features");
}
