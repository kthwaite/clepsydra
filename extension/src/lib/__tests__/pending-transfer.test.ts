import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CAPTURE_CHUNK,
	type CaptureChunk,
	ChunkAssembler,
} from "#/lib/chunked-transfer";
import {
	PENDING_TRANSFER_KEEP_ALIVE_MS,
	PendingTransferCoordinator,
} from "#/lib/pending-transfer";

interface Metadata {
	url: string;
}

const metadata: Metadata = { url: "https://example.com/article" };

function chunk(index: number, text: string, total = 2): CaptureChunk {
	return {
		type: CAPTURE_CHUNK,
		captureId: "cap-1",
		index,
		total,
		text,
	};
}

describe("PendingTransferCoordinator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		const assembler = new ChunkAssembler();
		const onExpire = vi.fn();
		const coordinator = new PendingTransferCoordinator<Metadata>({
			assembler,
			inactivityMs: 1_000,
			onExpire,
		});
		return { assembler, coordinator, onExpire };
	}

	function begin(
		coordinator: PendingTransferCoordinator<Metadata>,
		tabId = 7,
	): void {
		coordinator.acceptMetadata("cap-1", metadata, tabId);
		coordinator.acceptChunk(chunk(0, "ab"), tabId);
	}

	function expectCleared(
		coordinator: PendingTransferCoordinator<Metadata>,
		assembler: ChunkAssembler,
	): void {
		expect(coordinator.pending).toBe(0);
		expect(assembler.pending).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	}

	it("clears metadata, chunks, and the timer on completion", () => {
		const { assembler, coordinator } = setup();
		begin(coordinator);

		expect(coordinator.acceptChunk(chunk(1, "cd"), 7)).toEqual({
			metadata,
			snapshotHtml: "abcd",
			tabId: 7,
		});
		expectCleared(coordinator, assembler);
	});

	it("clears metadata, chunks, and the timer on explicit abort", () => {
		const { assembler, coordinator } = setup();
		begin(coordinator);

		coordinator.abort("cap-1");

		expectCleared(coordinator, assembler);
	});

	it("clears metadata, chunks, and the timer on inactivity expiry", () => {
		const { assembler, coordinator, onExpire } = setup();
		begin(coordinator);

		vi.advanceTimersByTime(1_000);

		expect(onExpire).toHaveBeenCalledWith("cap-1", 7);
		expectCleared(coordinator, assembler);
	});

	it("clears only transfers owned by a closed tab", () => {
		const { assembler, coordinator } = setup();
		begin(coordinator);
		coordinator.acceptMetadata("cap-2", metadata, 8);
		coordinator.acceptChunk({ ...chunk(0, "xy"), captureId: "cap-2" }, 8);

		coordinator.removeTab(7);

		expect(coordinator.pending).toBe(1);
		expect(assembler.pending).toBe(1);
		expect(vi.getTimerCount()).toBe(1);
		coordinator.removeTab(8);
		expectCleared(coordinator, assembler);
	});

	it("keeps one timer and resets inactivity on accepted chunks and metadata", () => {
		const { assembler, coordinator, onExpire } = setup();
		coordinator.acceptMetadata("cap-1", metadata, 7);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(900);
		coordinator.acceptChunk(chunk(0, "ab"), 7);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(900);
		coordinator.acceptMetadata("cap-1", metadata, 7);
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(900);
		expect(onExpire).not.toHaveBeenCalled();
		expect(coordinator.pending).toBe(1);
		expect(assembler.pending).toBe(1);

		vi.advanceTimersByTime(100);
		expect(onExpire).toHaveBeenCalledOnce();
		expectCleared(coordinator, assembler);
	});

	it("clears the affected transfer when a malformed chunk is rejected", () => {
		const { assembler, coordinator } = setup();
		begin(coordinator);

		expect(() => coordinator.acceptChunk(chunk(1, "cd", 3), 7)).toThrow(
			/cap-1.*total/,
		);
		expectCleared(coordinator, assembler);
	});

	it("clears coordinator state when aggregate text exceeds its bound", () => {
		const assembler = new ChunkAssembler({ maxTextLength: 5 });
		const coordinator = new PendingTransferCoordinator<Metadata>({
			assembler,
			inactivityMs: 1_000,
			onExpire: vi.fn(),
		});
		coordinator.acceptMetadata("cap-1", metadata, 7);
		coordinator.acceptChunk(chunk(0, "abc"), 7);

		expect(() => coordinator.acceptChunk(chunk(1, "def"), 7)).toThrow(
			"aggregate",
		);
		expectCleared(coordinator, assembler);
	});

	it("shares one keepalive until the last pending transfer terminates", () => {
		const keepAlive = vi.fn();
		const coordinator = new PendingTransferCoordinator<Metadata>({
			inactivityMs: 60_000,
			keepAlive,
			onExpire: vi.fn(),
		});

		coordinator.acceptMetadata("cap-1", metadata, 7);
		expect(vi.getTimerCount()).toBe(2);
		vi.advanceTimersByTime(PENDING_TRANSFER_KEEP_ALIVE_MS);
		expect(keepAlive).toHaveBeenCalledOnce();

		coordinator.acceptMetadata("cap-2", metadata, 8);
		expect(vi.getTimerCount()).toBe(3);
		vi.advanceTimersByTime(PENDING_TRANSFER_KEEP_ALIVE_MS);
		expect(keepAlive).toHaveBeenCalledTimes(2);

		coordinator.abort("cap-1");
		expect(vi.getTimerCount()).toBe(2);
		coordinator.abort("cap-2");
		expect(vi.getTimerCount()).toBe(0);
	});
});
