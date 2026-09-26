import type { ReactNode } from "react";
import type { FeatureName } from "#/api/features";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";

export function NotFoundPage() {
  return <p className="px-10 py-8 text-[14px] text-mute">Page not found.</p>;
}

export function FeatureGate({
  children,
  feature,
}: {
  children: ReactNode;
  feature: FeatureName;
}) {
  const features = useFeatureFlags();
  return features[feature] ? children : <NotFoundPage />;
}
