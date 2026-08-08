import { Navigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { useMobileLayout } from "#/hooks/useMobileLayout";

type DesktopOnlyRouteProps = {
  name: string;
  children: ReactNode;
};

export function DesktopOnlyRoute({
  name,
  children,
}: DesktopOnlyRouteProps) {
  const mobile = useMobileLayout();

  useEffect(() => {
    if (mobile) toast.info(`${name} is available on desktop.`);
  }, [mobile, name]);

  return mobile ? <Navigate to="/" replace /> : children;
}
