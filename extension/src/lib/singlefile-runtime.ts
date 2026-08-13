const FRAME_INIT_RESPONSE = "singlefile.frameTree.initResponse";
const FRAME_ACK_INIT_REQUEST = "singlefile.frameTree.ackInitRequest";
const LAZY_SET_TIMEOUT = "singlefile.lazyTimeout.setTimeout";
const LAZY_CLEAR_TIMEOUT = "singlefile.lazyTimeout.clearTimeout";
const LAZY_ON_TIMEOUT = "singlefile.lazyTimeout.onTimeout";
const MAX_TIMEOUT_MS = 0x7fff_ffff;

type SendToTab = (
	tabId: number,
	message: unknown,
	options?: { frameId: number },
) => Promise<unknown>;

type TimerHandle = number | NodeJS.Timeout;
interface LazyTimeoutMessage {
	method: typeof LAZY_SET_TIMEOUT | typeof LAZY_CLEAR_TIMEOUT;
	type: string;
	delay?: number;
}

function methodOf(message: unknown): unknown {
	return typeof message === "object" && message !== null && "method" in message
		? message.method
		: undefined;
}

function isFrameInitResponse(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		methodOf(message) === FRAME_INIT_RESPONSE &&
		"sessionId" in message &&
		typeof message.sessionId === "string" &&
		"frames" in message &&
		Array.isArray(message.frames) &&
		message.frames.every(
			(frame) =>
				typeof frame === "object" &&
				frame !== null &&
				"windowId" in frame &&
				typeof frame.windowId === "string",
		)
	);
}

function isFrameAck(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		methodOf(message) === FRAME_ACK_INIT_REQUEST &&
		"sessionId" in message &&
		typeof message.sessionId === "string" &&
		"windowId" in message &&
		typeof message.windowId === "string"
	);
}

function lazyMessage(message: unknown): LazyTimeoutMessage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const method = methodOf(message);
	if (method !== LAZY_SET_TIMEOUT && method !== LAZY_CLEAR_TIMEOUT) {
		return undefined;
	}
	if (
		!("type" in message) ||
		typeof message.type !== "string" ||
		message.type.length === 0
	) {
		return undefined;
	}
	if (method === LAZY_SET_TIMEOUT) {
		if (
			!("delay" in message) ||
			typeof message.delay !== "number" ||
			!Number.isSafeInteger(message.delay) ||
			message.delay < 0 ||
			message.delay > MAX_TIMEOUT_MS
		) {
			return undefined;
		}
		return { method, type: message.type, delay: message.delay };
	}
	return { method, type: message.type };
}

/** Upstream-compatible background routing required by single-file-core. */
export class SingleFileRuntime {
	private readonly timeouts = new Map<
		number,
		Map<number, Map<string, TimerHandle>>
	>();

	constructor(private readonly sendToTab: SendToTab) {}

	handleMessage(
		message: unknown,
		sender: chrome.runtime.MessageSender,
	): Promise<Record<string, never>> | undefined {
		const tabId = sender.tab?.id;
		if (tabId === undefined) return undefined;

		if (isFrameInitResponse(message) || isFrameAck(message)) {
			void this.sendToTab(tabId, message, { frameId: 0 }).catch(() => {});
			return Promise.resolve({});
		}

		const lazy = lazyMessage(message);
		if (!lazy) return undefined;
		const frameId = sender.frameId ?? 0;
		if (lazy.method === LAZY_CLEAR_TIMEOUT) {
			this.clear(tabId, frameId, lazy.type);
			return Promise.resolve({});
		}

		this.clear(tabId, frameId, lazy.type);
		const frameTimeouts = this.frameTimeouts(tabId, frameId);
		const timeout = setTimeout(() => {
			this.delete(tabId, frameId, lazy.type);
			void this.sendToTab(tabId, {
				method: LAZY_ON_TIMEOUT,
				type: lazy.type,
			}).catch(() => {});
		}, lazy.delay);
		frameTimeouts.set(lazy.type, timeout);
		return Promise.resolve({});
	}

	removeTab(tabId: number): void {
		const tabTimeouts = this.timeouts.get(tabId);
		if (!tabTimeouts) return;
		for (const frameTimeouts of tabTimeouts.values()) {
			for (const timeout of frameTimeouts.values()) clearTimeout(timeout);
		}
		this.timeouts.delete(tabId);
	}

	private frameTimeouts(
		tabId: number,
		frameId: number,
	): Map<string, TimerHandle> {
		let tabTimeouts = this.timeouts.get(tabId);
		if (!tabTimeouts) {
			tabTimeouts = new Map();
			this.timeouts.set(tabId, tabTimeouts);
		}
		let frameTimeouts = tabTimeouts.get(frameId);
		if (!frameTimeouts) {
			frameTimeouts = new Map();
			tabTimeouts.set(frameId, frameTimeouts);
		}
		return frameTimeouts;
	}

	private clear(tabId: number, frameId: number, type: string): void {
		const timeout = this.timeouts.get(tabId)?.get(frameId)?.get(type);
		clearTimeout(timeout);
		this.delete(tabId, frameId, type);
	}

	private delete(tabId: number, frameId: number, type: string): void {
		const tabTimeouts = this.timeouts.get(tabId);
		const frameTimeouts = tabTimeouts?.get(frameId);
		if (!frameTimeouts) return;
		frameTimeouts.delete(type);
		if (frameTimeouts.size === 0) tabTimeouts?.delete(frameId);
		if (tabTimeouts?.size === 0) this.timeouts.delete(tabId);
	}
}
