import { ChevronRight, File, Folder } from "lucide-react";
import { useMemo } from "react";
import { Button, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { useFolderTreePaths, usePages } from "#/api/pages";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  buildPageTree,
  ROOT_ID,
  type TreeData,
  type TreeNode,
} from "#/lib/buildPageTree";
import { cn } from "#/lib/cn";

function FileTreeItems({
  parentId,
  treeData,
}: {
  parentId: string;
  treeData: TreeData;
}) {
  const node = treeData.get(parentId);
  if (!node) return null;

  return (
    <>
      {node.children.map((childId) => {
        const child = treeData.get(childId);
        if (!child) return null;

        const hasChildren = child.isFolder && child.children.length > 0;

        return (
          <TreeItem
            key={child.id}
            id={child.id}
            textValue={child.name}
            hasChildItems={hasChildren}
          >
            <TreeItemContent>
              {({ isExpanded, isFocusVisible, level }) => (
                <div
                  className={cn(
                    "flex w-full items-center gap-1 truncate py-0.5 pr-2 text-foreground hover:bg-accent",
                    isFocusVisible &&
                      "outline outline-2 outline-ring outline-offset-[-2px]",
                  )}
                  style={{ paddingInlineStart: `${(level - 1) * 16}px` }}
                >
                  {child.isFolder ? (
                    <>
                      <Button slot="chevron" className="contents">
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 text-muted-foreground transition-transform",
                            isExpanded && "rotate-90",
                          )}
                        />
                      </Button>
                      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                    </>
                  ) : (
                    <>
                      <span className="w-3" />
                      <File className="h-3.5 w-3.5 text-muted-foreground" />
                    </>
                  )}
                  <span className="truncate">{child.name}</span>
                </div>
              )}
            </TreeItemContent>
            {hasChildren && (
              <FileTreeItems parentId={child.id} treeData={treeData} />
            )}
          </TreeItem>
        );
      })}
    </>
  );
}

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
    <Tree
      aria-label="File tree"
      selectionMode="none"
      className="text-sm"
      onAction={(key) => {
        const node = treeData.get(String(key));
        if (!node || node.isFolder || !node.page) return;
        openTab("page", node.page.path, node.page.title || node.page.path);
      }}
    >
      <FileTreeItems parentId={ROOT_ID} treeData={treeData} />
    </Tree>
  );
}
