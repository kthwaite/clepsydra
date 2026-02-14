export interface ArchiveManifest {
  url: string;
  canonical_url?: string;
  domain: string;
  title: string;
  description?: string;
  captured_at: string;
  content_hash: string;
  snapshot_hash: string;
  markdown_body: string;
  tags: string[];
  blobs: BlobUpload[];
}

export interface BlobUpload {
  hash: string;
  content_type: string;
  data: string; // base64
}

export interface ArchiveResponse {
  page_id: string;
  vault_path: string;
  blobs_stored: number;
  blobs_deduped: number;
  status: "created" | "already_exists" | "content_changed";
}

export interface ArchiveStatusResponse {
  enabled: boolean;
  blob_count: number;
  total_size_bytes: number;
}

export interface ExtensionSettings {
  server_url: string;
  api_key?: string;
  default_tags: string[];
  archive_path_prefix: string;
  notify_on_success: boolean;
  notify_on_duplicate: boolean;
  on_content_changed: "update" | "new_version" | "ask";
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  server_url: "http://localhost:3000",
  default_tags: [],
  archive_path_prefix: "archive",
  notify_on_success: true,
  notify_on_duplicate: true,
  on_content_changed: "ask",
};
