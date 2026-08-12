/**
 * Resource fetching for SingleFile, across the content-script / worker boundary.
 *
 * An MV3 content script's `fetch` is subject to the *page's* CORS policy, not
 * the extension's host permissions, so most cross-origin resources fail there.
 * `single-file-core` turns a failed fetch into an empty resource without
 * complaining, which would give us snapshots that look complete and are not.
 *
 * The page's own fetch is still tried first: it carries the session cookies that
 * make paywalled and authenticated captures work, and those are the only reason
 * capture happens in the browser at all.
 */

export const RELAY_FETCH = "relay_fetch";

export interface RelayFetchRequest {
	type: typeof RELAY_FETCH;
	url: string;
	headers?: Record<string, string>;
}

export interface RelayResponse {
	status: number;
	/** Lower-cased header names. */
	headers: Record<string, string>;
	base64: string;
}

export interface RelayFailure {
	error: string;
}

/** The subset of `Response` that `single-file-core`'s `getContent` reads. */
export interface SingleFileResponse {
	status: number;
	url: string;
	headers: { get: (name: string) => string | null };
	arrayBuffer: () => Promise<ArrayBuffer>;
}

interface FetchOptions {
	headers?: Record<string, string>;
}

function decodeBase64(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
	// String.fromCharCode(...bytes) spreads one argument per byte, which blows
	// the engine's argument-count limit for anything but a small image. Batch
	// the spread into 32KB chunks, each safely under that limit.
	const CHUNK_SIZE = 0x8000; // 32KB
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)));
	}
	return btoa(parts.join(""));
}

/** Content-script side: try the page, fall back to the worker. */
export function createRelayFetch(
	send: (message: unknown) => Promise<unknown>,
): (url: string, options?: FetchOptions) => Promise<SingleFileResponse> {
	return async function relayFetch(url, options = {}) {
		try {
			const direct = await globalThis.fetch(url, {
				cache: "force-cache",
				headers: options.headers,
				referrerPolicy: "strict-origin-when-cross-origin",
			});
			if (direct.ok) {
				return direct as unknown as SingleFileResponse;
			}
		} catch {
			// CORS, mixed content, or a dead host. The relay may still manage it.
		}

		const relayed = (await send({
			type: RELAY_FETCH,
			url,
			headers: options.headers,
		} satisfies RelayFetchRequest)) as RelayResponse | RelayFailure;

		if ("error" in relayed) {
			throw new Error(relayed.error);
		}

		const buffer = decodeBase64(relayed.base64);
		return {
			status: relayed.status,
			url,
			headers: {
				get: (name: string) => relayed.headers[name.toLowerCase()] ?? null,
			},
			arrayBuffer: async () => buffer,
		};
	};
}

/**
 * Worker side. Never throws: a rejection would cross the message boundary as an
 * opaque "could not establish connection" and lose the actual cause.
 */
export async function performRelayFetch(
	url: string,
	headers: Record<string, string> | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<RelayResponse | RelayFailure> {
	try {
		const response = await fetchImpl(url, {
			cache: "force-cache",
			credentials: "include",
			headers,
			referrerPolicy: "strict-origin-when-cross-origin",
		});
		const bytes = new Uint8Array(await response.arrayBuffer());
		const collected: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			collected[key.toLowerCase()] = value;
		});
		return {
			status: response.status,
			headers: collected,
			base64: encodeBase64(bytes),
		};
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
