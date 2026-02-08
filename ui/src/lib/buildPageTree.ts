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

function ensureChild(data: TreeData, parentId: string, childId: string) {
  const parent = data.get(parentId);
  if (!parent) return;

  if (!parent.children.includes(childId)) {
    parent.children.push(childId);
  }
}

function ensureFolderNode(data: TreeData, folderPath: string): string {
  const parts = folderPath.split("/").filter(Boolean);
  let parentId = ROOT_ID;

  for (let i = 0; i < parts.length; i++) {
    const folderId = parts.slice(0, i + 1).join("/");

    if (!data.has(folderId)) {
      data.set(folderId, {
        id: folderId,
        name: parts[i],
        isFolder: true,
        children: [],
        page: null,
      });
    }

    ensureChild(data, parentId, folderId);
    parentId = folderId;
  }

  return parentId;
}

function isHiddenInPagesTree(path: string): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    return false;
  }

  const rootSegment = normalized.split("/")[0];
  return rootSegment === "_attachments";
}

/**
 * Build a virtual folder tree from flat pages plus explicit folders.
 *
 * - Folders provided by `folderPaths` are rendered even when empty.
 * - Page paths still create required intermediate folder nodes.
 */
export function buildPageTree(
  pages: PageSummary[],
  folderPaths: string[] = [],
): TreeData {
  const data: TreeData = new Map<string, TreeNode>();
  data.set(ROOT_ID, {
    id: ROOT_ID,
    name: "",
    isFolder: true,
    children: [],
    page: null,
  });

  // First add explicit folder paths so empty folders are visible.
  for (const folderPath of folderPaths) {
    if (isHiddenInPagesTree(folderPath)) {
      continue;
    }

    ensureFolderNode(data, folderPath);
  }

  // Then add pages.
  for (const page of pages) {
    if (isHiddenInPagesTree(page.path)) {
      continue;
    }

    const parts = page.path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const parentId = parentPath ? ensureFolderNode(data, parentPath) : ROOT_ID;

    const leafId = page.path;
    data.set(leafId, {
      id: leafId,
      name: page.title || parts[parts.length - 1],
      isFolder: false,
      children: [],
      page,
    });

    ensureChild(data, parentId, leafId);
  }

  // Sort children: folders first, then alphabetically.
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
