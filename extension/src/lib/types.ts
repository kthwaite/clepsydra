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
	/** Provenance parsed from the page by Readability; all optional. */
	byline?: string;
	site_name?: string;
	published_time?: string;
	lang?: string;
	excerpt?: string;
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

/** Shape of the `detail` object the server attaches to a 409. */
export interface ArchiveConflictDetail {
	existing_hash?: string;
	new_hash?: string;
	page_id?: string;
	vault_path?: string;
}

export interface ExtensionSettings {
	server_url: string;
	default_tags: string[];
	notify_on_success: boolean;
	notify_on_duplicate: boolean;
	/**
	 * Mirrors the server's `archive.max_blob_size_mb` / `max_request_size_mb`
	 * (src/vault/config.rs). Checked client-side so one oversized image is
	 * skipped rather than failing the whole capture with a 400.
	 */
	max_blob_size_mb: number;
	max_request_size_mb: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
	server_url: "http://localhost:3000",
	default_tags: [],
	notify_on_success: true,
	notify_on_duplicate: true,
	max_blob_size_mb: 50,
	max_request_size_mb: 100,
};
