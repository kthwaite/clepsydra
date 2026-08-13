import { describe, expect, it } from "vitest";

import { ChunkAssembler, splitIntoChunks } from "#/lib/chunked-transfer";

describe("splitIntoChunks", () => {
	it("splits a payload into sized pieces that concatenate back", () => {
		const chunks = splitIntoChunks("cap-1", "abcdefg", 3);

		expect(chunks.map((c) => c.text)).toEqual(["abc", "def", "g"]);
		expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
		expect(chunks.every((c) => c.total === 3)).toBe(true);
	});

	it("emits a single chunk for a short payload", () => {
		expect(splitIntoChunks("cap-1", "abc", 1024)).toHaveLength(1);
	});

	it("emits one empty chunk for an empty payload", () => {
		// A zero-chunk capture would never complete on the receiving side.
		const chunks = splitIntoChunks("cap-1", "", 1024);

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
});

describe("ChunkAssembler", () => {
	it("returns null until the last chunk arrives", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcdefg", 3);

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
		const one = splitIntoChunks("cap-1", "aaaa", 2);
		const two = splitIntoChunks("cap-2", "bbbb", 2);

		expect(assembler.accept(one[0])).toBeNull();
		expect(assembler.accept(two[0])).toBeNull();
		expect(assembler.accept(one[1])).toBe("aaaa");
		expect(assembler.accept(two[1])).toBe("bbbb");
	});

	it("releases its buffer once a capture completes", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcd", 2);

		assembler.accept(chunks[0]);
		assembler.accept(chunks[1]);

		expect(assembler.pending).toBe(0);
	});

	it("ignores a duplicate chunk instead of double-counting it", () => {
		const assembler = new ChunkAssembler();
		const chunks = splitIntoChunks("cap-1", "abcd", 2);

		assembler.accept(chunks[0]);
		expect(assembler.accept(chunks[0])).toBeNull();
		expect(assembler.accept(chunks[1])).toBe("abcd");
	});

	it("forgets an abandoned capture", () => {
		// A tab closed mid-transfer would otherwise pin megabytes in a worker
		// that is meant to be able to suspend.
		const assembler = new ChunkAssembler();
		assembler.accept(splitIntoChunks("cap-1", "abcd", 2)[0]);

		assembler.forget("cap-1");

		expect(assembler.pending).toBe(0);
	});
});
