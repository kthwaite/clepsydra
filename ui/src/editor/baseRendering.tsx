import { createContext, type PropsWithChildren, useContext } from "react";
import type { GeneratedChangeSession } from "#/editor/usePageEditor";

export interface BaseRenderingLifecycle {
  pagePath: string;
  readonly: boolean;
  beginGeneratedChange(preparedBody?: string): Promise<GeneratedChangeSession>;
}

const BaseRenderingContext = createContext<BaseRenderingLifecycle | null>(null);

export function BaseRenderingProvider({
  value,
  children,
}: PropsWithChildren<{ value: BaseRenderingLifecycle }>) {
  return (
    <BaseRenderingContext.Provider value={value}>
      {children}
    </BaseRenderingContext.Provider>
  );
}

export function useBaseRendering() {
  return useContext(BaseRenderingContext);
}
