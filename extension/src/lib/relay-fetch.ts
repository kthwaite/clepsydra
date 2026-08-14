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

import { webext } from "#/lib/webext";
import { SNAPSHOT_NETWORK_TIMEOUT_MS } from "#/lib/singlefile";

export const RELAY_PORT_NAME = "singlefile-relay";
const RELAY_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RELAY_CHUNK_BASE64_LENGTH = 4 * Math.ceil(RELAY_CHUNK_BYTES / 3);
const MAX_RELAY_RESOURCE_BYTES = 0xffff_ffff;

export interface RelayFetchRequest {
	url: string;
	headers?: Record<string, string>;
	deadlineMs: number;
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
	const message = error instanceof Error ? error.message : String(error);
	return message || "Unknown relay fetch error";
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function isValidByteLength(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= MAX_RELAY_RESOURCE_BYTES
	);
}

function isRelayFetchRequest(message: unknown): message is RelayFetchRequest {
	return (
		typeof message === "object" &&
		message !== null &&
		!Array.isArray(message) &&
		"url" in message &&
		typeof message.url === "string" &&
		message.url.trim().length > 0 &&
		(!("headers" in message) ||
			message.headers === undefined ||
			isStringRecord(message.headers)) &&
		"deadlineMs" in message &&
		typeof message.deadlineMs === "number" &&
		Number.isSafeInteger(message.deadlineMs) &&
		message.deadlineMs >= 0 &&
		message.deadlineMs <= Date.now() + SNAPSHOT_NETWORK_TIMEOUT_MS
	);
}

function isRelayMetadata(message: unknown): message is RelayMetadata {
	return (
		typeof message === "object" &&
		message !== null &&
		!Array.isArray(message) &&
		"type" in message &&
		message.type === "metadata" &&
		"status" in message &&
		typeof message.status === "number" &&
		Number.isInteger(message.status) &&
		message.status >= 0 &&
		message.status <= 599 &&
		"url" in message &&
		typeof message.url === "string" &&
		message.url.trim().length > 0 &&
		"headers" in message &&
		isStringRecord(message.headers) &&
		"byteLength" in message &&
		isValidByteLength(message.byteLength)
	);
}

function isRelayChunk(message: unknown): message is RelayChunk {
	return (
		typeof message === "object" &&
		message !== null &&
		!Array.isArray(message) &&
		"type" in message &&
		message.type === "chunk" &&
		"base64" in message &&
		typeof message.base64 === "string" &&
		message.base64.length > 0 &&
		message.base64.length <= MAX_RELAY_CHUNK_BASE64_LENGTH
	);
}

function isRelayPull(message: unknown): message is RelayPull {
	return (
		typeof message === "object" &&
		message !== null &&
		!Array.isArray(message) &&
		"type" in message &&
		message.type === "pull"
	);
}

function isRelayAbort(message: unknown): message is RelayAbort {
	return (
		typeof message === "object" &&
		message !== null &&
		!Array.isArray(message) &&
		"type" in message &&
		message.type === "abort" &&
		"error" in message &&
		typeof message.error === "string" &&
		message.error.length > 0
	);
}

function disconnectPort(port: RelayPort): void {
	try {
		port.disconnect();
	} catch {
		// The peer already closed the port.
	}
}

/** Content-script side: try the page, fall back to one worker port per resource. */
export function createRelayFetch(
	connect?: RelayConnect,
): (url: string, options?: FetchOptions) => Promise<SingleFileResponse> {
	return async function relayFetch(url, options = {}) {
		const deadlineMs = Date.now() + SNAPSHOT_NETWORK_TIMEOUT_MS;
		const controller = new AbortController();
		const timeoutError = new Error(
			`Relay fetch timed out after ${SNAPSHOT_NETWORK_TIMEOUT_MS} ms`,
		);
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, SNAPSHOT_NETWORK_TIMEOUT_MS);
		const deadline = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(timeoutError), {
				once: true,
			});
		});

		try {
			const direct = await Promise.race([
				globalThis.fetch(url, {
					cache: "force-cache",
					headers: options.headers,
					referrerPolicy: "strict-origin-when-cross-origin",
					signal: controller.signal,
				}),
				deadline,
			]);
			if (direct.ok) {
				clearTimeout(timeout);
				return direct as unknown as SingleFileResponse;
			}
		} catch {
			if (timedOut) {
				clearTimeout(timeout);
				throw timeoutError;
			}
			// CORS, mixed content, or a dead host. The relay may still manage it.
		}

		if (timedOut || Date.now() >= deadlineMs) {
			clearTimeout(timeout);
			throw timeoutError;
		}

		const port = connect
			? connect({ name: RELAY_PORT_NAME })
			: (webext.runtime.connect as unknown as RelayConnect)({
					name: RELAY_PORT_NAME,
				});

		return await Promise.race([
			new Promise<SingleFileResponse>((resolve, reject) => {
				let metadata: RelayMetadata | undefined;
				let body: Uint8Array | undefined;
				let receivedBytes = 0;
				let settled = false;

				const cleanup = (): void => {
					clearTimeout(timeout);
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
					if (settled) return;

					try {
						if (isRelayAbort(message)) {
							fail(new Error(message.error), false);
							return;
						}

						const type =
							typeof message === "object" &&
							message !== null &&
							"type" in message
								? message.type
								: undefined;
						if (type === "abort") {
							fail(new Error("Relay fetch received an invalid abort"), true);
							return;
						}

						if (!metadata) {
							if (!isRelayMetadata(message)) {
								const reason =
									type === "metadata"
										? "Relay fetch received invalid metadata"
										: type === "chunk"
											? "Relay fetch received a chunk before metadata"
											: "Relay fetch received an unexpected message";
								fail(new Error(reason), true);
								return;
							}
							metadata = message;
							body = new Uint8Array(message.byteLength);
							pull();
							return;
						}

						if (type === "metadata") {
							fail(new Error("Relay fetch received invalid metadata"), true);
							return;
						}
						if (!isRelayChunk(message)) {
							fail(
								new Error(
									type === "chunk"
										? "Relay fetch received an invalid chunk"
										: "Relay fetch received an unexpected message",
								),
								true,
							);
							return;
						}

						let chunk: Uint8Array;
						try {
							chunk = decodeBase64(message.base64);
						} catch (error) {
							fail(
								new Error(
									`Relay fetch could not decode a chunk: ${errorMessage(error)}`,
								),
								true,
							);
							return;
						}
						if (
							chunk.byteLength > RELAY_CHUNK_BYTES ||
							receivedBytes + chunk.byteLength > metadata.byteLength
						) {
							fail(new Error("Relay fetch received an invalid chunk"), true);
							return;
						}
						body?.set(chunk, receivedBytes);
						receivedBytes += chunk.byteLength;
						pull();
					} catch (error) {
						fail(
							new Error(
								`Relay fetch could not process a port message: ${errorMessage(error)}`,
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
						deadlineMs,
					} satisfies RelayFetchRequest);
				} catch {
					fail(
						new Error(`Relay fetch disconnected before completion: ${url}`),
						false,
					);
				}
			}),
			deadline,
		]).catch((error: unknown) => {
			clearTimeout(timeout);
			if (timedOut) disconnectPort(port);
			throw error;
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
	let timeout: number | NodeJS.Timeout | undefined;

	const cleanup = (): void => {
		if (!active) return;
		active = false;
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
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
			if (!isValidByteLength(buffer.byteLength)) {
				reportError(new Error("Relay fetch response is too large"));
				return;
			}

			bytes = new Uint8Array(buffer);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key.toLowerCase()] = value;
			});
			const metadata: RelayMetadata = {
				type: "metadata",
				status: response.status,
				url: response.url,
				headers,
				byteLength: bytes.byteLength,
			};
			if (!isRelayMetadata(metadata)) {
				reportError(
					new Error("Relay fetch received invalid response metadata"),
				);
				return;
			}
			port.postMessage(metadata);
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

		try {
			const end = Math.min(offset + RELAY_CHUNK_BYTES, bytes.byteLength);
			const base64 = encodeBase64(bytes.subarray(offset, end));
			offset = end;
			port.postMessage({ type: "chunk", base64 } satisfies RelayChunk);
		} catch (error) {
			reportError(error);
		}
	};

	const onMessage = (message: unknown): void => {
		if (!active) return;
		try {
			if (!requestReceived) {
				if (!isRelayFetchRequest(message)) {
					reportError(new Error("Relay fetch received an invalid request"));
					return;
				}
				requestReceived = true;
				const remainingMs = Math.max(0, message.deadlineMs - Date.now());
				timeout = setTimeout(() => {
					reportError(
						new Error(
							`Relay fetch timed out after ${SNAPSHOT_NETWORK_TIMEOUT_MS} ms`,
						),
					);
				}, remainingMs);
				void fetchResource(message);
				return;
			}

			if (isRelayAbort(message)) {
				disconnect();
				return;
			}
			if (
				typeof message === "object" &&
				message !== null &&
				"type" in message &&
				message.type === "abort"
			) {
				reportError(new Error("Relay fetch received an invalid abort"));
				return;
			}
			if (isRelayPull(message)) {
				sendNextChunk();
				return;
			}
			reportError(
				new Error("Relay fetch received an unexpected worker message"),
			);
		} catch (error) {
			reportError(
				new Error(
					`Relay fetch could not process a content message: ${errorMessage(error)}`,
				),
			);
		}
	};

	const onDisconnect = (): void => {
		cleanup();
	};

	port.onMessage.addListener(onMessage);
	port.onDisconnect.addListener(onDisconnect);
}
