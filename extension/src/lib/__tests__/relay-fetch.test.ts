import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayFetch, performRelayFetch } from "#/lib/relay-fetch";

function response(
	body: Uint8Array,
	init: { status?: number; type?: string } = {},
) {
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		headers: new Headers({ "content-type": init.type ?? "image/png" }),
		arrayBuffer: async () => body.buffer,
	} as unknown as Response;
}

describe("createRelayFetch", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the page's own fetch when it succeeds", async () => {
		const pageFetch = vi
			.fn()
			.mockResolvedValue(response(new Uint8Array([1, 2])));
		vi.stubGlobal("fetch", pageFetch);
		const send = vi.fn();

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.png");

		expect(await result.arrayBuffer()).toEqual(new Uint8Array([1, 2]).buffer);
		expect(send).not.toHaveBeenCalled();
	});

	it("relays when the page's fetch throws on CORS", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: { "content-type": "image/png" },
			base64: "AQI=",
		});

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.png");

		expect(new Uint8Array(await result.arrayBuffer())).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(result.headers.get("content-type")).toBe("image/png");
	});

	it("relays when the page's fetch returns an error status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(response(new Uint8Array(), { status: 403 })),
		);
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: {},
			base64: "AQI=",
		});

		const relayFetch = createRelayFetch(send);
		await relayFetch("https://cdn.example.com/a.png");

		expect(send).toHaveBeenCalledOnce();
	});

	it("propagates a relay failure so SingleFile records an empty resource", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
		const send = vi
			.fn()
			.mockResolvedValue({ error: "net::ERR_NAME_NOT_RESOLVED" });

		const relayFetch = createRelayFetch(send);

		await expect(relayFetch("https://cdn.example.com/a.png")).rejects.toThrow(
			"net::ERR_NAME_NOT_RESOLVED",
		);
	});

	it("looks headers up case-insensitively", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("nope")));
		const send = vi.fn().mockResolvedValue({
			status: 200,
			headers: { "content-type": "text/css" },
			base64: "",
		});

		const relayFetch = createRelayFetch(send);
		const result = await relayFetch("https://cdn.example.com/a.css");

		expect(result.headers.get("Content-Type")).toBe("text/css");
	});
});

describe("performRelayFetch", () => {
	it("returns status, headers and base64 bytes", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(response(new Uint8Array([1, 2])));

		const result = await performRelayFetch(
			"https://cdn.example.com/a.png",
			undefined,
			fetchImpl,
		);

		expect(result).toEqual({
			status: 200,
			headers: { "content-type": "image/png" },
			base64: "AQI=",
		});
	});

	it("sends cookies, because that is the point of relaying", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(response(new Uint8Array()));

		await performRelayFetch(
			"https://cdn.example.com/a.png",
			undefined,
			fetchImpl,
		);

		expect(fetchImpl.mock.calls[0][1]).toMatchObject({
			credentials: "include",
		});
	});

	it("reports a failure rather than throwing across the message boundary", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(new Error("ERR_CONNECTION_REFUSED"));

		const result = await performRelayFetch(
			"https://cdn.example.com/a.png",
			undefined,
			fetchImpl,
		);

		expect(result).toEqual({ error: "ERR_CONNECTION_REFUSED" });
	});
});
