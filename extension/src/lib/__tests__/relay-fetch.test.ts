import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	type RelayPort,
	createRelayFetch,
	handleRelayFetchPort,
} from "#/lib/relay-fetch";

class FakeEvent<TArgs extends unknown[]> {
	private readonly listeners = new Set<(...args: TArgs) => void>();

	addListener(listener: (...args: TArgs) => void): void {
		this.listeners.add(listener);
	}

	removeListener(listener: (...args: TArgs) => void): void {
		this.listeners.delete(listener);
	}

	emit(...args: TArgs): void {
		for (const listener of [...this.listeners]) listener(...args);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

type PortEvent = {
	from: "content" | "worker";
	message: unknown;
};

class FakePort implements RelayPort {
	readonly onMessage = new FakeEvent<[unknown]>();
	readonly onDisconnect = new FakeEvent<[]>();
	readonly sent: unknown[] = [];
	peer: FakePort | undefined;
	disconnected = false;
	shouldDeliver: (message: unknown) => boolean = () => true;

	constructor(
		readonly name: string,
		private readonly side: PortEvent["from"],
		private readonly events: PortEvent[],
	) {}

	postMessage(message: unknown): void {
		if (this.disconnected) throw new Error("Port is disconnected");
		this.sent.push(message);
		this.events.push({ from: this.side, message });
		if (!this.shouldDeliver(message)) return;
		queueMicrotask(() => {
			if (!this.disconnected && !this.peer?.disconnected) {
				this.peer?.onMessage.emit(message);
			}
		});
	}

	disconnect(): void {
		if (this.disconnected) return;
		this.disconnected = true;
		if (this.peer) this.peer.disconnected = true;
		queueMicrotask(() => {
			this.onDisconnect.emit();
			this.peer?.onDisconnect.emit();
		});
	}
}

function pairedPorts() {
	const events: PortEvent[] = [];
	const content = new FakePort("singlefile-relay", "content", events);
	const worker = new FakePort("singlefile-relay", "worker", events);
	content.peer = worker;
	worker.peer = content;
	return { content, worker, events };
}

function response(
	body: Uint8Array,
	init: {
		status?: number;
		url?: string;
		headers?: Record<string, string>;
	} = {},
) {
	const bytes = body.buffer.slice(
		body.byteOffset,
		body.byteOffset + body.byteLength,
	);
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		url: init.url ?? "https://cdn.example.com/a.png",
		headers: new Headers(init.headers ?? { "content-type": "image/png" }),
		arrayBuffer: async () => bytes.slice(0),
	} as unknown as Response;
}

function relayFixture(fetchImpl: typeof fetch) {
	const ports = pairedPorts();
	const connect = vi.fn(() => {
		handleRelayFetchPort(ports.worker, fetchImpl);
		return ports.content;
	});
	return { ...ports, connect };
}

function isMessageType(
	message: unknown,
	type: string,
): message is Record<string, unknown> & { type: string } {
	return (
		typeof message === "object" &&
		message !== null &&
		"type" in message &&
		message.type === type
	);
}

describe("createRelayFetch", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the page fetch first with its existing options", async () => {
		const pageFetch = vi
			.fn()
			.mockResolvedValue(response(new Uint8Array([1, 2])));
		vi.stubGlobal("fetch", pageFetch);
		const connect = vi.fn();
		const headers = { Accept: "image/avif" };

		const relayFetch = createRelayFetch(connect);
		const result = await relayFetch("https://cdn.example.com/a.png", {
			headers,
		});

		expect(new Uint8Array(await result.arrayBuffer())).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(pageFetch).toHaveBeenCalledWith("https://cdn.example.com/a.png", {
			cache: "force-cache",
			headers,
			referrerPolicy: "strict-origin-when-cross-origin",
		});
		expect(connect).not.toHaveBeenCalled();
	});

	it("reconstructs a resource larger than 4 MiB over bounded pull/ack chunks", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		const body = new Uint8Array(4 * 1024 * 1024 + 19);
		for (let index = 0; index < body.length; index++) {
			body[index] = (index * 31 + 7) & 0xff;
		}
		const fetchImpl = vi.fn().mockResolvedValue(
			response(body, {
				status: 206,
				url: "https://edge.example.com/final.png",
				headers: {
					"Content-Type": "image/png",
					"X-Resource-Version": "seven",
				},
			}),
		);
		const { connect, content, events, worker } = relayFixture(fetchImpl);
		const nativeBtoa = globalThis.btoa;
		const encodedInputSizes: number[] = [];
		vi.stubGlobal("btoa", (binary: string) => {
			encodedInputSizes.push(binary.length);
			return nativeBtoa(binary);
		});
		const headers = { Accept: "image/png" };

		const result = await createRelayFetch(connect)(
			"https://cdn.example.com/a.png",
			{ headers },
		);
		const reconstructed = new Uint8Array(await result.arrayBuffer());

		expect(connect).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledWith({ name: "singlefile-relay" });
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://cdn.example.com/a.png",
			expect.objectContaining({
				cache: "force-cache",
				credentials: "include",
				headers,
				referrerPolicy: "strict-origin-when-cross-origin",
				signal: expect.any(AbortSignal),
			}),
		);
		expect(content.sent[0]).toEqual({
			url: "https://cdn.example.com/a.png",
			headers,
		});
		expect(result.status).toBe(206);
		expect(result.url).toBe("https://edge.example.com/final.png");
		expect(result.headers.get("Content-Type")).toBe("image/png");
		expect(result.headers.get("X-RESOURCE-VERSION")).toBe("seven");
		expect(reconstructed.byteLength).toBe(body.byteLength);
		expect(reconstructed.every((value, index) => value === body[index])).toBe(
			true,
		);

		const metadata = worker.sent.find((message) =>
			isMessageType(message, "metadata"),
		);
		expect(metadata).toEqual({
			type: "metadata",
			status: 206,
			url: "https://edge.example.com/final.png",
			headers: {
				"content-type": "image/png",
				"x-resource-version": "seven",
			},
			byteLength: body.byteLength,
		});

		const chunks = worker.sent.filter((message) =>
			isMessageType(message, "chunk"),
		);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(atob(chunk.base64 as string).length).toBeLessThanOrEqual(
				4 * 1024 * 1024,
			);
		}
		expect(Math.max(...encodedInputSizes)).toBeLessThanOrEqual(4 * 1024 * 1024);

		let outstandingChunk = false;
		let pulls = 0;
		for (const event of events) {
			if (event.from === "worker" && isMessageType(event.message, "chunk")) {
				expect(outstandingChunk).toBe(false);
				outstandingChunk = true;
			}
			if (event.from === "content" && isMessageType(event.message, "pull")) {
				pulls++;
				outstandingChunk = false;
			}
		}
		expect(outstandingChunk).toBe(false);
		expect(pulls).toBe(chunks.length + 1);
		expect(content.disconnected).toBe(true);
		expect(worker.disconnected).toBe(true);
	});

	it("falls back when the page fetch returns an error status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response(new Uint8Array(), { status: 403 })),
		);
		const { connect } = relayFixture(
			vi.fn().mockResolvedValue(response(new Uint8Array([1, 2]))),
		);

		const result = await createRelayFetch(connect)(
			"https://cdn.example.com/a.png",
		);

		expect(new Uint8Array(await result.arrayBuffer())).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(connect).toHaveBeenCalledOnce();
	});

	it("rejects a premature disconnect and aborts and releases the worker transfer", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CORS")));
		let workerSignal: AbortSignal | undefined;
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				workerSignal = init?.signal ?? undefined;
				return response(new Uint8Array(1024));
			},
		);
		const { connect, content, worker } = relayFixture(fetchImpl);
		content.shouldDeliver = (message) => !isMessageType(message, "pull");

		const result = createRelayFetch(connect)("https://cdn.example.com/a.png");
		await vi.waitFor(() => {
			expect(
				worker.sent.some((message) => isMessageType(message, "metadata")),
			).toBe(true);
		});
		content.disconnect();

		await expect(result).rejects.toThrow(
			"Relay fetch disconnected before completion",
		);
		expect(workerSignal?.aborted).toBe(true);
		await vi.waitFor(() => {
			expect(content.onMessage.listenerCount).toBe(0);
			expect(content.onDisconnect.listenerCount).toBe(0);
			expect(worker.onMessage.listenerCount).toBe(0);
			expect(worker.onDisconnect.listenerCount).toBe(0);
		});
	});

	it("reports worker fetch errors as readable failures", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CORS")));
		const { connect, worker } = relayFixture(
			vi.fn().mockRejectedValue(new Error("net::ERR_NAME_NOT_RESOLVED")),
		);

		await expect(
			createRelayFetch(connect)("https://missing.example.com/a.png"),
		).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
		expect(worker.sent).toContainEqual({
			type: "abort",
			error: "net::ERR_NAME_NOT_RESOLVED",
		});
	});
});
