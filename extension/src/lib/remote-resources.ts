/**
 * Fetching of remote page images for archival.
 *
 * Guards implemented here:
 *
 * - **Timeouts.** Every request is bounded. Previously a single hanging CDN
 *   stalled the whole capture forever, because all fetches were awaited
 *   together with no abort signal.
 * - **Auth retry.** Hotlink-protected images reject the service worker's
 *   credentialed cross-origin request. One retry is made without credentials
 *   and with the page as referrer before giving up.
 * - **Size limits.** A per-resource cap and a total budget, applied in document
 *   order so the outcome does not depend on which fetch finished first. One
 *   oversized hero image no longer fails the entire capture.
 * - **Honest accounting.** Everything not archived — truncated by the cap,
 *   timed out, rejected, or too large — is counted, so a partial archive can
 *   say so instead of looking complete.
 */

export interface FetchedResource {
	src: string;
	absoluteSrc: string;
	hash: string;
	contentType: string;
	bytes: Uint8Array<ArrayBuffer>;
}

export interface RemoteFetchResult {
	resources: FetchedResource[];
	/** Candidate images that were not archived, for any reason. */
	skipped: number;
}

export interface RemoteFetchOptions {
	pageUrl: string;
	maxImages: number;
	perResourceTimeoutMs: number;
	maxBlobBytes: number;
	totalBudgetBytes: number;
	hash: (data: Uint8Array<ArrayBuffer>) => Promise<string>;
	fetchImpl?: typeof fetch;
	/** Resources already captured inline, which must not be refetched. */
	alreadyArchived?: (src: string) => boolean;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/** Statuses that plausibly indicate a referrer or credentials problem. */
const RETRYABLE_STATUSES = new Set([401, 403, 404]);

function resolveAbsoluteUrl(url: string, baseUrl: string): string | null {
	try {
		return new URL(url, baseUrl).href;
	} catch {
		return null;
	}
}

function timeoutSignal(ms: number): AbortSignal {
	if (typeof AbortSignal.timeout === "function") {
		return AbortSignal.timeout(ms);
	}
	const controller = new AbortController();
	setTimeout(() => controller.abort(), ms);
	return controller.signal;
}

function normalizeContentType(response: Response): string {
	const raw = response.headers.get("content-type");
	if (!raw) return DEFAULT_CONTENT_TYPE;
	return raw.split(";")[0]?.trim() || DEFAULT_CONTENT_TYPE;
}

type Candidate =
	| { kind: "fetched"; resource: FetchedResource }
	| { kind: "skipped" }
	| { kind: "ignored" };

async function fetchOne(
	src: string,
	options: RemoteFetchOptions,
): Promise<Candidate> {
	const { pageUrl, perResourceTimeoutMs, maxBlobBytes, hash, alreadyArchived } =
		options;
	const doFetch = options.fetchImpl ?? fetch;

	if (src.startsWith("data:")) return { kind: "ignored" };

	const absoluteSrc = resolveAbsoluteUrl(src, pageUrl);
	if (!absoluteSrc) return { kind: "skipped" };

	if (alreadyArchived?.(src) || alreadyArchived?.(absoluteSrc)) {
		return { kind: "ignored" };
	}

	try {
		let response = await doFetch(absoluteSrc, {
			credentials: "include",
			signal: timeoutSignal(perResourceTimeoutMs),
		});

		if (!response.ok && RETRYABLE_STATUSES.has(response.status)) {
			// Cross-origin credentialed requests are refused by many CDNs, and the
			// worker sends no referrer of its own. Try once the other way round.
			response = await doFetch(absoluteSrc, {
				credentials: "omit",
				referrer: pageUrl,
				referrerPolicy: "origin",
				signal: timeoutSignal(perResourceTimeoutMs),
			});
		}

		if (!response.ok) return { kind: "skipped" };

		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBlobBytes) return { kind: "skipped" };

		const data = new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
		return {
			kind: "fetched",
			resource: {
				src,
				absoluteSrc,
				hash: await hash(data),
				contentType: normalizeContentType(response),
				bytes: data,
			},
		};
	} catch {
		return { kind: "skipped" };
	}
}

export async function fetchRemoteImages(
	sources: string[],
	options: RemoteFetchOptions,
): Promise<RemoteFetchResult> {
	const considered = sources.slice(0, options.maxImages);
	let skipped = sources.length - considered.length;

	const candidates = await Promise.all(
		considered.map((src) => fetchOne(src, options)),
	);

	// Apply the total budget in document order so the result does not depend on
	// which request happened to settle first.
	const resources: FetchedResource[] = [];
	const counted = new Set<string>();
	let total = 0;

	for (const candidate of candidates) {
		if (candidate.kind === "ignored") continue;
		if (candidate.kind === "skipped") {
			skipped += 1;
			continue;
		}

		const { resource } = candidate;
		// Identical bytes cost the budget once; the server dedups by hash anyway.
		const isNew = !counted.has(resource.hash);
		if (isNew && total + resource.bytes.byteLength > options.totalBudgetBytes) {
			skipped += 1;
			continue;
		}

		if (isNew) {
			counted.add(resource.hash);
			total += resource.bytes.byteLength;
		}
		resources.push(resource);
	}

	return { resources, skipped };
}
