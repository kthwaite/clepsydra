import {
  hotkeysCoreFeature,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useFolderTreePaths, usePages } from "#/api/pages";
import { useOpenTab } from "#/hooks/useOpenTab";
import { buildPageTree, ROOT_ID, type TreeNode } from "#/lib/buildPageTree";

export function FileTree() {
  const {
    data: pagesData,
    isLoading: isLoadingPages,
    error: pagesError,
  } = usePages();
  const {
    data: folderPaths,
    isLoading: isLoadingFolders,
    error: foldersError,
  } = useFolderTreePaths();

  const pages = pagesData?.items;
  const openTab = useOpenTab();

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

    return buildPageTree(pages, folderPaths ?? []);
  }, [pages, folderPaths]);

  const tree = useTree<TreeNode>({
    rootItemId: ROOT_ID,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().isFolder,
    dataLoader: {
      getItem: (id) => treeData.get(id)!,
      getChildren: (id) => treeData.get(id)?.children ?? [],
    },
    onPrimaryAction: (item) => {
      const node = item.getItemData();
      if (node.isFolder || !node.page) {
        return;
      }

      openTab("page", node.page.path, node.page.title || node.page.path);
    },
    indent: 16,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // syncDataLoaderFeature caches its initial read. When treeData changes
  // (query resolution, SSE invalidation), tell headless-tree to re-read.
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, treeData]);

  if (isLoadingPages || isLoadingFolders) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
    );
  }

  if (pagesError || foldersError) {
    return (
      <p className="px-2 py-1 text-xs text-destructive">Failed to load pages</p>
    );
  }

  const hasItems = (treeData.get(ROOT_ID)?.children.length ?? 0) > 0;
  if (!hasItems) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No pages</p>;
  }

  return (
    <div {...tree.getContainerProps()} className="text-sm">
      {tree.getItems().map((item) => {
        const node = item.getItemData();

        const itemProps = item.getProps();

        return (
          <button
            key={item.getKey()}
            {...itemProps}
            type="button"
            className="flex w-full items-center gap-1 truncate py-0.5 pr-2 text-left text-foreground hover:bg-accent"
            style={{ paddingLeft: `${item.getItemMeta().level * 16}px` }}
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
