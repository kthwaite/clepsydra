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

export const RELAY_PORT_NAME = "singlefile-relay";
const RELAY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface RelayFetchRequest {
	url: string;
	headers?: Record<string, string>;
}

export interface RelayMetadata {
	type: "metadata";
	status: number;
	url: string;
	/** Lower-cased header names. */
	headers: Record<string, string>;
	byteLength: number;
}

export interface RelayChunk {
	type: "chunk";
	base64: string;
}

export interface RelayPull {
	type: "pull";
}

export interface RelayAbort {
	type: "abort";
	error: string;
}

export type RelayPortMessage =
	| RelayMetadata
	| RelayChunk
	| RelayPull
	| RelayAbort;

interface RelayEvent<TArgs extends unknown[]> {
	addListener(listener: (...args: TArgs) => void): void;
	removeListener(listener: (...args: TArgs) => void): void;
}

/** The runtime.Port surface shared by Chrome and the paired-port tests. */
export interface RelayPort {
	readonly name: string;
	readonly onMessage: RelayEvent<[unknown]>;
	readonly onDisconnect: RelayEvent<[]>;
	postMessage(message: unknown): void;
	disconnect(): void;
}

export type RelayConnect = (connectInfo: { name: string }) => RelayPort;

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

function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	// String.fromCharCode(...bytes) spreads one argument per byte, which blows
	// the engine's argument-count limit for anything but a small image.
	const BINARY_BATCH_BYTES = 0x8000;
	const parts: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += BINARY_BATCH_BYTES) {
		parts.push(
			String.fromCharCode(
				...bytes.subarray(offset, offset + BINARY_BATCH_BYTES),
			),
		);
	}
	return btoa(parts.join(""));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRelayMessage(message: unknown): message is RelayPortMessage {
	if (typeof message !== "object" || message === null || !("type" in message)) {
		return false;
	}
	return (
		message.type === "metadata" ||
		message.type === "chunk" ||
		message.type === "pull" ||
		message.type === "abort"
	);
}

/** Content-script side: try the page, fall back to one worker port per resource. */
export function createRelayFetch(
	connect?: RelayConnect,
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

		const port = connect
			? connect({ name: RELAY_PORT_NAME })
			: (chrome.runtime.connect as unknown as RelayConnect)({
					name: RELAY_PORT_NAME,
				});

		return await new Promise<SingleFileResponse>((resolve, reject) => {
			let metadata: RelayMetadata | undefined;
			let body: Uint8Array | undefined;
			let receivedBytes = 0;
			let settled = false;

			const cleanup = (): void => {
				port.onMessage.removeListener(onMessage);
				port.onDisconnect.removeListener(onDisconnect);
			};

			const disconnect = (): void => {
				try {
					port.disconnect();
				} catch {
					// A concurrent worker disconnect already closed the port.
				}
			};

			const fail = (error: Error, notifyWorker: boolean): void => {
				if (settled) return;
				settled = true;
				body = undefined;
				if (notifyWorker) {
					try {
						port.postMessage({
							type: "abort",
							error: error.message,
						} satisfies RelayAbort);
					} catch {
						// The disconnect itself may be the failure.
					}
				}
				cleanup();
				disconnect();
				reject(error);
			};

			const pull = (): void => {
				try {
					port.postMessage({ type: "pull" } satisfies RelayPull);
				} catch {
					fail(
						new Error(`Relay fetch disconnected before completion: ${url}`),
						false,
					);
				}
			};

			const onMessage = (message: unknown): void => {
				if (settled || !isRelayMessage(message)) return;

				if (message.type === "abort") {
					fail(new Error(message.error), false);
					return;
				}

				if (message.type === "metadata") {
					if (
						metadata ||
						!Number.isSafeInteger(message.byteLength) ||
						message.byteLength < 0
					) {
						fail(new Error("Relay fetch received invalid metadata"), true);
						return;
					}
					metadata = message;
					body = new Uint8Array(message.byteLength);
					pull();
					return;
				}

				if (message.type !== "chunk" || !metadata || !body) {
					fail(new Error("Relay fetch received an unexpected message"), true);
					return;
				}

				try {
					const chunk = decodeBase64(message.base64);
					if (
						chunk.byteLength > RELAY_CHUNK_BYTES ||
						receivedBytes + chunk.byteLength > metadata.byteLength
					) {
						fail(new Error("Relay fetch received an invalid chunk"), true);
						return;
					}
					body.set(chunk, receivedBytes);
					receivedBytes += chunk.byteLength;
					pull();
				} catch (error) {
					fail(
						new Error(
							`Relay fetch could not decode a chunk: ${errorMessage(error)}`,
						),
						true,
					);
				}
			};

			const onDisconnect = (): void => {
				if (settled) return;
				cleanup();
				if (!metadata || !body || receivedBytes !== metadata.byteLength) {
					settled = true;
					body = undefined;
					reject(
						new Error(`Relay fetch disconnected before completion: ${url}`),
					);
					return;
				}

				settled = true;
				const completedMetadata = metadata;
				// `body` is allocated above, so its backing store cannot be shared.
				const completedBody = body.buffer as ArrayBuffer;
				body = undefined;
				resolve({
					status: completedMetadata.status,
					url: completedMetadata.url,
					headers: {
						get: (name: string) =>
							completedMetadata.headers[name.toLowerCase()] ?? null,
					},
					arrayBuffer: async () => completedBody,
				});
			};

			port.onMessage.addListener(onMessage);
			port.onDisconnect.addListener(onDisconnect);
			try {
				port.postMessage({
					url,
					headers: options.headers,
				} satisfies RelayFetchRequest);
			} catch {
				fail(
					new Error(`Relay fetch disconnected before completion: ${url}`),
					false,
				);
			}
		});
	};
}

/** Worker side: serve exactly one relayed resource over this port. */
export function handleRelayFetchPort(
	port: RelayPort,
	fetchImpl: typeof fetch = fetch,
): void {
	const controller = new AbortController();
	let bytes: Uint8Array | undefined;
	let offset = 0;
	let requestReceived = false;
	let active = true;

	const cleanup = (): void => {
		if (!active) return;
		active = false;
		controller.abort();
		bytes = undefined;
		port.onMessage.removeListener(onMessage);
		port.onDisconnect.removeListener(onDisconnect);
	};

	const disconnect = (): void => {
		cleanup();
		try {
			port.disconnect();
		} catch {
			// A concurrent content-script disconnect already closed the port.
		}
	};

	const reportError = (error: unknown): void => {
		if (!active) return;
		try {
			port.postMessage({
				type: "abort",
				error: errorMessage(error),
			} satisfies RelayAbort);
		} catch {
			// The peer disconnected while the failure was being reported.
		}
		cleanup();
	};

	const fetchResource = async (request: RelayFetchRequest): Promise<void> => {
		try {
			const response = await fetchImpl(request.url, {
				cache: "force-cache",
				credentials: "include",
				headers: request.headers,
				referrerPolicy: "strict-origin-when-cross-origin",
				signal: controller.signal,
			});
			const buffer = await response.arrayBuffer();
			if (!active) return;

			bytes = new Uint8Array(buffer);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
			port.postMessage({
				type: "metadata",
				status: response.status,
				url: response.url,
				headers,
				byteLength: bytes.byteLength,
			} satisfies RelayMetadata);
		} catch (error) {
			reportError(error);
		}
	};

	const sendNextChunk = (): void => {
		if (!bytes) {
			reportError(new Error("Relay fetch received a pull before metadata"));
			return;
		}
		if (offset === bytes.byteLength) {
			disconnect();
			return;
		}

		const end = Math.min(offset + RELAY_CHUNK_BYTES, bytes.byteLength);
		const base64 = encodeBase64(bytes.subarray(offset, end));
		offset = end;
		try {
			port.postMessage({ type: "chunk", base64 } satisfies RelayChunk);
		} catch (error) {
			reportError(error);
		}
	};

	const onMessage = (message: unknown): void => {
		if (!active) return;
		if (!requestReceived) {
			if (
				typeof message !== "object" ||
				message === null ||
				!("url" in message) ||
				typeof message.url !== "string"
			) {
				reportError(new Error("Relay fetch received an invalid request"));
				return;
			}
			requestReceived = true;
			void fetchResource(message as RelayFetchRequest);
			return;
		}

		if (!isRelayMessage(message)) {
			reportError(new Error("Relay fetch received an unexpected message"));
			return;
		}
		if (message.type === "abort") {
			disconnect();
			return;
		}
		if (message.type === "pull") {
			sendNextChunk();
			return;
		}
		reportError(new Error("Relay fetch received an unexpected worker message"));
	};

	const onDisconnect = (): void => {
		cleanup();
	};

	port.onMessage.addListener(onMessage);
	port.onDisconnect.addListener(onDisconnect);
}
