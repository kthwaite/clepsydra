import { describe, expect, it, vi } from "vitest";
import { fetchRemoteImages } from "../remote-resources";

const PAGE_URL = "https://example.com/post";

function bytes(n: number, fill = 7): Uint8Array<ArrayBuffer> {
	return new Uint8Array(new ArrayBuffer(n)).fill(
		fill,
	) as Uint8Array<ArrayBuffer>;
}

function okResponse(body: Uint8Array<ArrayBuffer>, contentType = "image/png") {
	return new Response(body, {
		status: 200,
		headers: { "content-type": contentType },
	});
}

const hash = async (data: Uint8Array<ArrayBuffer>) =>
	`sha256:len${data.byteLength}-${data[0] ?? 0}`;

function baseOptions(
	overrides: Partial<Parameters<typeof fetchRemoteImages>[1]> = {},
) {
	return {
		pageUrl: PAGE_URL,
		maxImages: 50,
		perResourceTimeoutMs: 1000,
		maxBlobBytes: 1024,
		totalBudgetBytes: 8192,
		hash,
		fetchImpl: vi.fn(async () =>
			okResponse(bytes(10)),
		) as unknown as typeof fetch,
		...overrides,
	};
}

describe("fetchRemoteImages", () => {
	it("resolves relative URLs against the page URL", async () => {
		const fetchImpl = vi.fn(async () => okResponse(bytes(10)));
		const result = await fetchRemoteImages(
			["/img/a.png"],
			baseOptions({ fetchImpl: fetchImpl as unknown as typeof fetch }),
		);

		expect(result.resources).toHaveLength(1);
		expect(result.resources[0].absoluteSrc).toBe(
			"https://example.com/img/a.png",
		);
		expect(result.skipped).toBe(0);
	});

	it("skips data: URIs without counting them as failures", async () => {
		const result = await fetchRemoteImages(
			["data:image/png;base64,AAAA"],
			baseOptions(),
		);
		expect(result.resources).toHaveLength(0);
		expect(result.skipped).toBe(0);
	});

	it("aborts a resource that exceeds the per-resource timeout", async () => {
		const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
		});

		const result = await fetchRemoteImages(
			["https://cdn.example.com/slow.png"],
			baseOptions({
				perResourceTimeoutMs: 10,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		);

		expect(result.resources).toHaveLength(0);
		expect(result.skipped).toBe(1);
	});

	it("retries once without credentials when the origin rejects the request", async () => {
		const calls: RequestInit[] = [];
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			calls.push(init ?? {});
			if (calls.length === 1) return new Response("", { status: 403 });
			return okResponse(bytes(12));
		});

		const result = await fetchRemoteImages(
			["https://cdn.example.com/hotlinked.png"],
			baseOptions({ fetchImpl: fetchImpl as unknown as typeof fetch }),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(calls[0].credentials).toBe("include");
		expect(calls[1].credentials).toBe("omit");
		expect(calls[1].referrer).toBe(PAGE_URL);
		expect(result.resources).toHaveLength(1);
		expect(result.skipped).toBe(0);
	});

	it("does not retry on a non-auth failure", async () => {
		const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
		const result = await fetchRemoteImages(
			["https://cdn.example.com/broken.png"],
			baseOptions({ fetchImpl: fetchImpl as unknown as typeof fetch }),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(1);
	});

	it("skips a single oversized resource but keeps the rest", async () => {
		const fetchImpl = vi.fn(async (url: string) =>
			url.includes("huge") ? okResponse(bytes(5000)) : okResponse(bytes(10)),
		);

		const result = await fetchRemoteImages(
			["https://cdn.example.com/huge.png", "https://cdn.example.com/small.png"],
			baseOptions({
				maxBlobBytes: 1024,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		);

		expect(result.resources.map((r) => r.absoluteSrc)).toEqual([
			"https://cdn.example.com/small.png",
		]);
		expect(result.skipped).toBe(1);
	});

	it("stops at the total budget deterministically, in document order", async () => {
		// Distinct bytes per URL: identical images dedupe by hash and are only
		// charged to the budget once, which is covered separately below.
		const fetchImpl = vi.fn(async (url: string) =>
			okResponse(bytes(400, Number(url.match(/(\d)\.png/)?.[1] ?? 0))),
		);
		const sources = [
			"https://cdn.example.com/1.png",
			"https://cdn.example.com/2.png",
			"https://cdn.example.com/3.png",
		];

		const result = await fetchRemoteImages(
			sources,
			baseOptions({
				maxBlobBytes: 1024,
				totalBudgetBytes: 900,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		);

		expect(result.resources.map((r) => r.absoluteSrc)).toEqual([
			"https://cdn.example.com/1.png",
			"https://cdn.example.com/2.png",
		]);
		expect(result.skipped).toBe(1);
	});

	it("counts images dropped by the maxImages cap", async () => {
		const sources = Array.from(
			{ length: 5 },
			(_unused, i) => `https://cdn.example.com/${i}.png`,
		);
		const result = await fetchRemoteImages(
			sources,
			baseOptions({ maxImages: 2 }),
		);

		expect(result.resources).toHaveLength(2);
		expect(result.skipped).toBe(3);
	});

	it("does not refetch resources already archived as data URIs", async () => {
		const fetchImpl = vi.fn(async () => okResponse(bytes(10)));
		const result = await fetchRemoteImages(
			["https://cdn.example.com/known.png"],
			baseOptions({
				fetchImpl: fetchImpl as unknown as typeof fetch,
				alreadyArchived: (src) => src.includes("known"),
			}),
		);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(result.resources).toHaveLength(0);
		expect(result.skipped).toBe(0);
	});

	it("strips content-type parameters", async () => {
		const fetchImpl = vi.fn(async () =>
			okResponse(bytes(10), "image/jpeg; charset=binary"),
		);
		const result = await fetchRemoteImages(
			["https://cdn.example.com/p.jpg"],
			baseOptions({ fetchImpl: fetchImpl as unknown as typeof fetch }),
		);

		expect(result.resources[0].contentType).toBe("image/jpeg");
	});
});

describe("budget accounting", () => {
	it("charges duplicate images to the budget only once", async () => {
		const fetchImpl = vi.fn(async () => okResponse(bytes(400, 9)));
		const sources = [
			"https://cdn.example.com/a.png",
			"https://cdn.example.com/b.png",
			"https://cdn.example.com/c.png",
		];

		const result = await fetchRemoteImages(
			sources,
			baseOptions({
				maxBlobBytes: 1024,
				totalBudgetBytes: 900,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		);

		// All three are the same bytes, so all three fit within a 900-byte budget.
		expect(result.resources).toHaveLength(3);
		expect(result.skipped).toBe(0);
	});
});
