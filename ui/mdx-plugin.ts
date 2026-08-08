import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Plugin } from "vite";

export function createMdxPlugin(): Plugin {
  const plugin = mdx({
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSlug],
  });
  const transform = plugin.transform;

  if (typeof transform !== "function") {
    throw new TypeError("Expected @mdx-js/rollup to provide a transform hook");
  }

  return {
    ...plugin,
    enforce: "pre",
    transform(source, id) {
      if (id.includes("?raw")) {
        return null;
      }

      return transform.call(this, source, id);
    },
  };
}
