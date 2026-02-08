export interface PageSummary {
  id: string;
  path: string;
  title: string | null;
  canonical_name: string;
}

export interface PageDetail {
  path: string;
  canonical_name: string;
  meta: PageMeta;
  body: string;
}

export interface PageMeta {
  id: string;
  title: string | null;
  tags: string[];
  aliases: string[];
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export interface BacklinkEntry {
  source_id: string;
  source_path: string;
  source_title: string | null;
  target_raw: string;
  kind: string;
  context: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  path: string;
  title: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface VaultStats {
  pages: number;
  links_total: number;
  links_resolved: number;
  links_unresolved: number;
  tags: number;
  attachments: number;
}
