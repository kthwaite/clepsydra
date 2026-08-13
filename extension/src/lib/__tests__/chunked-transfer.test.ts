import { describe, expect, it, vi } from "vitest";

import {
	CAPTURE_CHUNK,
	CHUNK_SIZE,
	type CaptureChunk,
	ChunkAssembler,
	MAX_CAPTURE_CHUNKS,
	MAX_CAPTURE_TEXT_LENGTH,
	sendCaptureTransfer,
	splitIntoChunks,
} from "#/lib/chunked-transfer";

function chunk(overrides: Partial<CaptureChunk> = {}): CaptureChunk {
	return {
		type: CAPTURE_CHUNK,
		captureId: "cap-1",
		index: 0,
		total: 2,
		text: "ab",
		...overrides,
	};
}

describe("splitIntoChunks", () => {
	it("splits a payload into sized pieces that concatenate back", () => {
		const chunks = Array.from(splitIntoChunks("cap-1", "abcdefg", 3));

		expect(chunks.map((part) => part.text)).toEqual(["abc", "def", "g"]);
		expect(chunks.map((part) => part.index)).toEqual([0, 1, 2]);
		expect(chunks.every((part) => part.total === 3)).toBe(true);
	});

	it("emits a single chunk for a short payload", () => {
		const chunks = Array.from(splitIntoChunks("cap-1", "abc", 1024));

		expect(chunks).toHaveLength(1);
	});

	it("emits one empty chunk for an empty payload", () => {
		// A zero-chunk capture would never complete on the receiving side.
		const chunks = Array.from(splitIntoChunks("cap-1", "", 1024));

		expect(chunks).toEqual([
			{
				type: "capture_chunk",
				captureId: "cap-1",
				index: 0,
				total: 1,
				text: "",
			},
		]);
	});

	it("returns a lazy iterable and slices only as iteration advances", () => {
		const slice = vi.spyOn(String.prototype, "slice");

		try {
			const chunks = splitIntoChunks("cap-1", "abcdefg", 3);
			expect(Array.isArray(chunks)).toBe(false);
			expect(slice).not.toHaveBeenCalled();

			const iterator = chunks[Symbol.iterator]();
			expect(iterator.next().value?.text).toBe("abc");
			expect(slice).toHaveBeenCalledTimes(1);
			expect(iterator.next().value?.text).toBe("def");
			expect(slice).toHaveBeenCalledTimes(2);
		} finally {
			slice.mockRestore();
		}
	});
});

describe("ChunkAssembler", () => {
	it("returns null until the last chunk arrives", () => {
		const assembler = new ChunkAssembler();
		const chunks = Array.from(splitIntoChunks("cap-1", "abcdefg", 3));

		expect(assembler.accept(chunks[0])).toBeNull();
		expect(assembler.accept(chunks[1])).toBeNull();
		expect(assembler.accept(chunks[2])).toBe("abcdefg");
	});

	it("reassembles out-of-order chunks", () => {
		const assembler = new ChunkAssembler();
		const [a, b, c] = splitIntoChunks("cap-1", "abcdefg", 3);

		expect(assembler.accept(c)).toBeNull();
		expect(assembler.accept(a)).toBeNull();
		expect(assembler.accept(b)).toBe("abcdefg");
	});

	it("keeps concurrent captures apart", () => {
		const assembler = new ChunkAssembler();
		const [oneA, oneB] = splitIntoChunks("cap-1", "aaaa", 2);
		const [twoA, twoB] = splitIntoChunks("cap-2", "bbbb", 2);

		expect(assembler.accept(oneA)).toBeNull();
		expect(assembler.accept(twoA)).toBeNull();
		expect(assembler.accept(oneB)).toBe("aaaa");
		expect(assembler.accept(twoB)).toBe("bbbb");
	});

	it("releases its buffer once a capture completes", () => {
		const assembler = new ChunkAssembler();
		const [first, second] = splitIntoChunks("cap-1", "abcd", 2);

		assembler.accept(first);
		assembler.accept(second);

		expect(assembler.pending).toBe(0);
	});

	it.each([
		["zero total", chunk({ total: 0 }), "total"],
		["negative total", chunk({ total: -1 }), "total"],
		["fractional total", chunk({ total: 1.5 }), "total"],
		[
			"unsafe total",
			chunk({ total: Number.MAX_SAFE_INTEGER + 1 }),
			"safe integer",
		],
		["negative index", chunk({ index: -1 }), "index"],
		["index equal to total", chunk({ index: 2 }), "index"],
		["fractional index", chunk({ index: 0.5 }), "index"],
		[
			"unsafe index",
			chunk({ index: Number.MAX_SAFE_INTEGER + 1 }),
			"safe integer",
		],
	] as const)("rejects an invalid %s", (_case, invalid, detail) => {
		const assembler = new ChunkAssembler();

		expect(() => assembler.accept(invalid)).toThrow(detail);
		expect(assembler.pending).toBe(0);
	});

	it("accepts the maximum declared total and rejects one above it", () => {
		expect(MAX_CAPTURE_CHUNKS).toBe(128);
		const accepted = new ChunkAssembler();
		expect(accepted.accept(chunk({ total: MAX_CAPTURE_CHUNKS }))).toBeNull();
		expect(accepted.pending).toBe(1);

		const rejected = new ChunkAssembler();
		expect(() =>
			rejected.accept(chunk({ total: MAX_CAPTURE_CHUNKS + 1 })),
		).toThrow(/total.*128/);
		expect(rejected.pending).toBe(0);
	});

	it.each([
		["empty", ""],
		["non-string", 42],
	] as const)("rejects a %s capture id", (_case, captureId) => {
		const assembler = new ChunkAssembler();
		const invalid = { ...chunk(), captureId } as unknown as CaptureChunk;

		expect(() => assembler.accept(invalid)).toThrow("captureId");
		expect(assembler.pending).toBe(0);
	});

	it.each([
		["null", null],
		["number", 42],
	] as const)(
		"rejects %s chunk text and clears existing state",
		(_case, text) => {
			const assembler = new ChunkAssembler();
			assembler.accept(chunk());
			const invalid = {
				...chunk({ index: 1 }),
				text,
			} as unknown as CaptureChunk;

			expect(() => assembler.accept(invalid)).toThrow("text");
			expect(assembler.pending).toBe(0);
		},
	);

	it("accepts the chunk-size boundary and rejects one character above it", () => {
		const accepted = new ChunkAssembler();
		expect(accepted.accept(chunk({ text: "x".repeat(CHUNK_SIZE) }))).toBeNull();
		expect(accepted.pending).toBe(1);

		const rejected = new ChunkAssembler();
		expect(() =>
			rejected.accept(chunk({ text: "x".repeat(CHUNK_SIZE + 1) })),
		).toThrow("size");
		expect(rejected.pending).toBe(0);
	});

	it("accepts the aggregate boundary and rejects one character above it", () => {
		expect(MAX_CAPTURE_TEXT_LENGTH).toBe(512 * 1024 * 1024);
		const accepted = new ChunkAssembler({ maxTextLength: 5 });
		accepted.accept(chunk({ text: "ab" }));
		expect(accepted.accept(chunk({ index: 1, text: "cde" }))).toBe("abcde");

		const rejected = new ChunkAssembler({ maxTextLength: 5 });
		rejected.accept(chunk({ text: "abc" }));
		expect(() => rejected.accept(chunk({ index: 1, text: "def" }))).toThrow(
			/aggregate.*5/,
		);
		expect(rejected.pending).toBe(0);
	});

	it("rejects a changed total and clears the capture", () => {
		const assembler = new ChunkAssembler();
		assembler.accept(chunk());

		expect(() =>
			assembler.accept(chunk({ index: 1, total: 3, text: "cd" })),
		).toThrow("total");
		expect(assembler.pending).toBe(0);
	});

	it("accepts an exact duplicate without double-counting it", () => {
		const assembler = new ChunkAssembler();
		const first = chunk();

		assembler.accept(first);
		expect(assembler.accept(first)).toBeNull();
		expect(assembler.accept(chunk({ index: 1, text: "cd" }))).toBe("abcd");
	});

	it("rejects a conflicting duplicate and clears the capture", () => {
		const assembler = new ChunkAssembler();
		assembler.accept(chunk());

		expect(() => assembler.accept(chunk({ text: "changed" }))).toThrow(
			"duplicate",
		);
		expect(assembler.pending).toBe(0);
	});

	it("clears existing state when a later chunk is malformed", () => {
		const assembler = new ChunkAssembler();
		assembler.accept(chunk());

		expect(() => assembler.accept(chunk({ index: -1 }))).toThrow("index");
		expect(assembler.pending).toBe(0);
	});

	it("forgets an abandoned capture", () => {
		// A tab closed mid-transfer would otherwise pin megabytes in a worker
		// that is meant to be able to suspend.
		const assembler = new ChunkAssembler();
		const [first] = splitIntoChunks("cap-1", "abcd", 2);
		assembler.accept(first);

		assembler.forget("cap-1");

		expect(assembler.pending).toBe(0);
	});
});

describe("sendCaptureTransfer", () => {
	it("attempts an abort when metadata delivery fails", async () => {
		const failure = new Error("metadata channel closed");
		const send = vi
			.fn<(message: unknown) => Promise<unknown>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(undefined);
		const metadata = { type: "capture_meta", captureId: "cap-1" };

		await expect(
			sendCaptureTransfer("cap-1", metadata, "snapshot", send),
		).rejects.toBe(failure);
		expect(send).toHaveBeenNthCalledWith(1, metadata);
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "capture_abort",
			captureId: "cap-1",
			error: "Error: metadata channel closed",
		});
	});

	it("attempts an abort when chunk delivery fails without masking the failure", async () => {
		const failure = new Error("chunk channel closed");
		const abortFailure = new Error("abort channel closed");
		const send = vi
			.fn<(message: unknown) => Promise<unknown>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(failure)
			.mockRejectedValueOnce(abortFailure);

		await expect(
			sendCaptureTransfer(
				"cap-1",
				{ type: "capture_meta", captureId: "cap-1" },
				"snapshot",
				send,
			),
		).rejects.toBe(failure);
		expect(send).toHaveBeenLastCalledWith({
			type: "capture_abort",
			captureId: "cap-1",
			error: "Error: chunk channel closed",
		});
	});
});
