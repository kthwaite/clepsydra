import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureQueue, type Timers } from "../capture-queue";

function deferred() {
	let resolve!: () => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let handles: number;
let active: Map<number, () => void>;
let timers: Timers;
let keepAlive: ReturnType<typeof vi.fn>;

beforeEach(() => {
	handles = 0;
	active = new Map();
	timers = {
		setInterval: ((handler: () => void) => {
			handles += 1;
			active.set(handles, handler);
			return handles as unknown as ReturnType<typeof setInterval>;
		}) as Timers["setInterval"],
		clearInterval: ((handle: unknown) => {
			active.delete(handle as number);
		}) as Timers["clearInterval"],
	};
	keepAlive = vi.fn();
});

function makeQueue() {
	return new CaptureQueue({ keepAlive, keepAliveMs: 20, timers });
}

describe("CaptureQueue", () => {
	it("suppresses a duplicate capture for the same key", async () => {
		const queue = makeQueue();
		const first = deferred();
		const task = vi.fn(() => first.promise);

		expect(queue.run("https://example.com/a", task)).toBe(true);
		expect(queue.run("https://example.com/a", task)).toBe(false);
		expect(task).toHaveBeenCalledTimes(1);
		expect(queue.size).toBe(1);

		first.resolve();
		await first.promise;
		await Promise.resolve();
	});

	it("allows the same key again once the first capture settles", async () => {
		const queue = makeQueue();
		const first = deferred();
		queue.run("https://example.com/a", () => first.promise);

		first.resolve();
		await first.promise;
		await Promise.resolve();

		expect(queue.isInFlight("https://example.com/a")).toBe(false);
		expect(queue.run("https://example.com/a", async () => {})).toBe(true);
	});

	it("runs different keys concurrently", () => {
		const queue = makeQueue();
		expect(queue.run("a", () => deferred().promise)).toBe(true);
		expect(queue.run("b", () => deferred().promise)).toBe(true);
		expect(queue.size).toBe(2);
	});

	it("keeps the worker alive only while work is outstanding", async () => {
		const queue = makeQueue();
		const first = deferred();

		expect(active.size).toBe(0);
		queue.run("a", () => first.promise);
		expect(active.size).toBe(1);

		// simulate the interval firing
		for (const handler of active.values()) handler();
		expect(keepAlive).toHaveBeenCalledTimes(1);

		first.resolve();
		await first.promise;
		await Promise.resolve();

		expect(active.size).toBe(0);
	});

	it("stops the keep-alive when a capture rejects", async () => {
		const queue = makeQueue();
		const first = deferred();
		queue.run("a", () => first.promise.catch(() => {}));

		first.reject(new Error("network died"));
		await first.promise.catch(() => {});
		await Promise.resolve();
		await Promise.resolve();

		expect(active.size).toBe(0);
		expect(queue.size).toBe(0);
	});

	it("does not start a second keep-alive for a concurrent capture", () => {
		const queue = makeQueue();
		queue.run("a", () => deferred().promise);
		queue.run("b", () => deferred().promise);
		expect(handles).toBe(1);
	});
});
