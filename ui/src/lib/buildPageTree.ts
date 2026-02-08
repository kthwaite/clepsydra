import type { PageSummary } from "#/api/types";

export interface TreeNode {
  id: string;
  name: string;
  isFolder: boolean;
  children: string[];
  page: PageSummary | null;
}

export type TreeData = Record<string, TreeNode>;

/**
 * Build a virtual folder tree from a flat page list.
 *
 * Each page path like "library/papers/foo.md" produces:
 * - folder "root" with child "library"
 * - folder "library" with child "library/papers"
 * - folder "library/papers" with child "library/papers/foo.md"
 * - leaf "library/papers/foo.md" pointing to the page
 */
export function buildPageTree(pages: PageSummary[]): TreeData {
  const data: TreeData = {
    root: {
      id: "root",
      name: "root",
      isFolder: true,
      children: [],
      page: null,
    },
  };

  for (const page of pages) {
    const parts = page.path.split("/");
    let parentId = "root";

    // Create intermediate folder nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const folderId = parts.slice(0, i + 1).join("/");
      if (!data[folderId]) {
        data[folderId] = {
          id: folderId,
          name: parts[i],
          isFolder: true,
          children: [],
          page: null,
        };
        data[parentId].children.push(folderId);
      }
      parentId = folderId;
    }

    // Create leaf node for the page
    const leafId = page.path;
    data[leafId] = {
      id: leafId,
      name: page.title || parts[parts.length - 1],
      isFolder: false,
      children: [],
      page,
    };

    if (!data[parentId].children.includes(leafId)) {
      data[parentId].children.push(leafId);
    }
  }

  // Sort children: folders first, then alphabetically
  for (const node of Object.values(data)) {
    node.children.sort((a, b) => {
      const aFolder = data[a]?.isFolder ? 0 : 1;
      const bFolder = data[b]?.isFolder ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      return (data[a]?.name ?? "").localeCompare(data[b]?.name ?? "");
    });
  }

  return data;
}
