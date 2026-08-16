import {
	type MockInstance,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	ArchiveConflictError,
	ArchiveError,
	ClepsydraClient,
} from "../api-client";
import type {
	ArchiveLookupResponse,
	ArchiveManifest,
	ArchiveResponse,
	ArchiveStatusResponse,
} from "../types";

const BASE_URL = "http://localhost:3000";

function makeManifest(
	overrides: Partial<ArchiveManifest> = {},
): ArchiveManifest {
	return {
		url: "https://example.com/article",
		domain: "example.com",
		title: "Test Article",
		captured_at: "2026-02-14T00:00:00Z",
		content_hash: "abc123",
		snapshot_html: "<html><body>Test</body></html>",
		markdown_body: "# Test\n\nHello world.",
		tags: ["test"],
		...overrides,
	};
}

describe("ClepsydraClient", () => {
	let client: ClepsydraClient;
	let fetchSpy: MockInstance;

	beforeEach(() => {
		client = new ClepsydraClient(BASE_URL);
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	describe("ingestArchive", () => {
		it("returns response on 201", async () => {
			const archiveResponse: ArchiveResponse = {
				page_id: "page-1",
				vault_path: "archive/example-com/test-article",
				blobs_stored: 2,
				blobs_deduped: 0,
				status: "created",
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(archiveResponse), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.ingestArchive(makeManifest());
			expect(result).toEqual(archiveResponse);
			expect(fetchSpy).toHaveBeenCalledWith(`${BASE_URL}/api/vault/archive`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(makeManifest()),
			});
		});

		it("returns response on 200 (duplicate)", async () => {
			const archiveResponse: ArchiveResponse = {
				page_id: "page-1",
				vault_path: "archive/example-com/test-article",
				blobs_stored: 0,
				blobs_deduped: 2,
				status: "already_exists",
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(archiveResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.ingestArchive(makeManifest());
			expect(result).toEqual(archiveResponse);
		});

		it("throws ArchiveConflictError on 409", async () => {
			const conflictDetail = {
				message: "Content hash mismatch",
				existing_hash: "xyz789",
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(conflictDetail), {
					status: 409,
					headers: { "Content-Type": "application/json" },
				}),
			);

			try {
				await client.ingestArchive(makeManifest());
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(ArchiveConflictError);
				expect((e as ArchiveConflictError).detail).toEqual(conflictDetail);
				expect((e as ArchiveConflictError).message).toBe(
					"URL already archived with different content",
				);
			}
		});

		it("throws ArchiveError on other error status codes", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response("Internal Server Error", { status: 500 }),
			);

			try {
				await client.ingestArchive(makeManifest());
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(ArchiveError);
				expect((e as ArchiveError).message).toBe(
					"Server returned 500: Internal Server Error",
				);
			}
		});
	});

	describe("lookupArchive", () => {
		it("fetches the lookup endpoint and returns the parsed body", async () => {
			const lookupResponse: ArchiveLookupResponse = {
				status: "active",
				page_id: "page-1",
				vault_path: "archive/example.com/x.md",
				captured_at: "2026-08-13T12:00:00Z",
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(lookupResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.lookupArchive(
				"https://example.com/article?x=1",
			);
			expect(result).toEqual(lookupResponse);
			expect(fetchSpy).toHaveBeenCalledWith(
				`${BASE_URL}/api/vault/archive/lookup?url=${encodeURIComponent(
					"https://example.com/article?x=1",
				)}`,
			);
		});

		it("throws ArchiveError on non-OK status", async () => {
			fetchSpy.mockResolvedValueOnce(
				new Response("Bad Request", { status: 400 }),
			);

			try {
				await client.lookupArchive("not-a-url");
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(ArchiveError);
				expect((e as ArchiveError).message).toBe("Lookup failed: 400");
			}
		});
	});

	describe("isReachable", () => {
		it("returns true when server responds", async () => {
			const statusResponse: ArchiveStatusResponse = {
				enabled: true,
				blob_count: 42,
				total_size_bytes: 1024000,
			};

			fetchSpy.mockResolvedValueOnce(
				new Response(JSON.stringify(statusResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const result = await client.isReachable();
			expect(result).toBe(true);
		});

		it("returns false when server is down", async () => {
			fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));

			const result = await client.isReachable();
			expect(result).toBe(false);
		});
	});
});
