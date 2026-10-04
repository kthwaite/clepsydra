import { createContext, type PropsWithChildren, useContext } from "react";
import type { Descendant } from "slate";
import type { GeneratedChangeSession } from "#/editor/usePageEditor";

export interface BaseRenderingLifecycle {
  pagePath: string;
  readonly: boolean;
  beginGeneratedChange(preparedBody?: string): Promise<GeneratedChangeSession>;
  /**
   * Serializes editor nodes to markdown. Injected by the host because
   * `#/editor/convert` imports the schema registry, which imports the
   * element renderers that consume this context.
   */
  serializeMarkdown(nodes: Descendant[]): string;
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
