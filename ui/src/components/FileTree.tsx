import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, File, Folder } from "lucide-react";
import { useMemo } from "react";
import { usePages } from "#/api/pages";
import {
  ROOT_ID,
  buildPageTree,
  type TreeNode,
} from "#/lib/buildPageTree";

export function FileTree() {
  const { data, isLoading, error } = usePages();
  const pages = data?.items;
  const navigate = useNavigate();

  const treeData = useMemo(() => {
    if (!pages) {
      const empty = new Map<string, TreeNode>();
      empty.set(ROOT_ID, {
        id: ROOT_ID,
        name: "",
        isFolder: true,
        children: [],
        page: null,
      });
      return empty;
    }
    return buildPageTree(pages);
  }, [pages]);

  const tree = useTree<TreeNode>({
    rootItemId: ROOT_ID,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader: {
      getItem: (id) => treeData.get(id)!,
      getChildren: (id) => treeData.get(id)?.children ?? [],
    },
    indent: 16,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  if (isLoading) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
    );
  }
  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-destructive">Failed to load pages</p>
    );
  }
  if (!pages || pages.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No pages</p>;
  }

  return (
    <div {...tree.getContainerProps()} className="text-sm">
      {tree.getItems().map((item) => {
        const node = item.getItemData();

        return (
          <button
            key={item.getKey()}
            {...item.getProps()}
            type="button"
            className="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left text-foreground hover:bg-accent"
            style={{ paddingLeft: `${item.getItemMeta().level * 16}px` }}
            onClick={() => {
              if (node.isFolder) {
                item.isExpanded() ? item.collapse() : item.expand();
              } else if (node.page) {
                navigate({
                  to: "/pages/$",
                  params: { _splat: node.page.path },
                });
              }
            }}
          >
            {node.isFolder ? (
              <>
                <ChevronRight
                  className={`h-3 w-3 text-muted-foreground transition-transform ${
                    item.isExpanded() ? "rotate-90" : ""
                  }`}
                />
                <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              </>
            ) : (
              <>
                <span className="w-3" />
                <File className="h-3.5 w-3.5 text-muted-foreground" />
              </>
            )}
            <span className="truncate">{item.getItemName()}</span>
          </button>
        );
      })}
    </div>
  );
}
