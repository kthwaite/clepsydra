import type { InlineSourceAdapter } from "#/editor/inlineSourceEditing";
import { wikilinkSourceAdapter } from "#/editor/wikilinkSourceAdapter";

/** Every inline element type whose Markdown source ←/→ can open. */
export const INLINE_SOURCE_ADAPTERS: readonly InlineSourceAdapter[] = [
  wikilinkSourceAdapter,
];

export const INLINE_SOURCE_TYPES: readonly string[] =
  INLINE_SOURCE_ADAPTERS.map((adapter) => adapter.type);
