/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module "*.mdx" {
  import type { ComponentType } from "react";
  import type { MDXComponents } from "mdx/types";
  import type { DocMeta } from "#/docs/types";

  export const meta: DocMeta;
  const Component: ComponentType<{ components?: MDXComponents }>;
  export default Component;
}
