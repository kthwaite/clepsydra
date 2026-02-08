import type { PageSummary } from "#/api/types";

export const ROOT_ID = "\0";

export interface TreeNode {
  id: string;
  name: string;
  isFolder: boolean;
  children: string[];
  page: PageSummary | null;
}

export type TreeData = Map<string, TreeNode>;

/**
 * Build a virtual folder tree from a flat page list.
 *
 * Each page path like "library/papers/foo.md" produces:
 * - folder ROOT_ID with child "library"
 * - folder "library" with child "library/papers"
 * - folder "library/papers" with child "library/papers/foo.md"
 * - leaf "library/papers/foo.md" pointing to the page
 *
 * Uses a Map to avoid prototype-key collisions (e.g. "constructor").
 * The synthetic root uses "\0" as its ID to avoid colliding with a
 * real "root/" folder.
 */
export function buildPageTree(pages: PageSummary[]): TreeData {
  const data: TreeData = new Map<string, TreeNode>();
  data.set(ROOT_ID, {
    id: ROOT_ID,
    name: "",
    isFolder: true,
    children: [],
    page: null,
  });

  for (const page of pages) {
    const parts = page.path.split("/");
    let parentId = ROOT_ID;

    // Create intermediate folder nodes
    for (let i = 0; i < parts.length - 1; i++) {
      const folderId = parts.slice(0, i + 1).join("/");
      if (!data.has(folderId)) {
        data.set(folderId, {
          id: folderId,
          name: parts[i],
          isFolder: true,
          children: [],
          page: null,
        });
        data.get(parentId)!.children.push(folderId);
      }
      parentId = folderId;
    }

    // Create leaf node for the page
    const leafId = page.path;
    data.set(leafId, {
      id: leafId,
      name: page.title || parts[parts.length - 1],
      isFolder: false,
      children: [],
      page,
    });

    const parent = data.get(parentId)!;
    if (!parent.children.includes(leafId)) {
      parent.children.push(leafId);
    }
  }

  // Sort children: folders first, then alphabetically
  for (const node of data.values()) {
    node.children.sort((a, b) => {
      const aNode = data.get(a);
      const bNode = data.get(b);
      const aFolder = aNode?.isFolder ? 0 : 1;
      const bFolder = bNode?.isFolder ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      return (aNode?.name ?? "").localeCompare(bNode?.name ?? "");
    });
  }

  return data;
}
