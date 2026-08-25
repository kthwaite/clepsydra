import type { ReactNode } from "react";
import type { FeatureName } from "#/api/features";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";

export function NotFoundPage() {
  return (
    <div className="cl-cap p-8 text-[var(--ink-mute)]">
      404 · folio missing
    </div>
  );
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
