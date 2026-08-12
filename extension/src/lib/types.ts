export interface ArchiveManifest {
	url: string;
	canonical_url?: string;
	domain: string;
	title: string;
	description?: string;
	captured_at: string;
	/** sha256 of `markdown_body` as sent; the server's transport check. */
	content_hash: string;
	/** The SingleFile capture, resources still inlined. The server deconstructs it. */
	snapshot_html: string;
	markdown_body: string;
	tags: string[];
	/** Provenance parsed from the page by Readability; all optional. */
	byline?: string;
	site_name?: string;
	published_time?: string;
	lang?: string;
	excerpt?: string;
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
	 * Mirrors the server's `archive.max_blob_size_mb` (src/vault/config.rs). Handed
	 * to SingleFile as `maxResourceSize` so it declines an oversized resource at
	 * capture time, rather than sending a payload the server will reject.
	 */
	max_blob_size_mb: number;
	/**
	 * Mirrors the server's `archive.max_request_size_mb`, but is inert on the
	 * client: its only consumer was `buildResourceMap`'s total-capture budget,
	 * deleted along with client-side resource fetching. The server alone now
	 * enforces this limit. Kept on the type and in `DEFAULT_SETTINGS` only so a
	 * stored settings object keeps round-tripping through
	 * `{ ...DEFAULT_SETTINGS, ...stored.settings }`; the options page no longer
	 * reads or writes it.
	 */
	max_request_size_mb: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
	server_url: "http://localhost:3000",
	default_tags: [],
	notify_on_success: true,
	notify_on_duplicate: true,
	max_blob_size_mb: 100,
	max_request_size_mb: 250,
};
