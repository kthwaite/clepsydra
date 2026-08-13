/**
 * Moving a capture from the content script to the service worker.
 *
 * A SingleFile snapshot is megabytes of string, and Chrome requires extension
 * messages to be JSON-serialisable and rejects oversized ones. So the payload
 * travels in pieces.
 *
 * A `chrome.runtime.Port` was the obvious alternative and is worse: it needs
 * request/response correlation code that repeated `sendMessage` calls get for
 * free, and it adds a disconnect lifecycle to reason about.
 */

export const CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_CAPTURE_CHUNKS = 128;
export const MAX_CAPTURE_TEXT_LENGTH = 512 * 1024 * 1024;

export const CAPTURE_CHUNK = "capture_chunk";
export const CAPTURE_ABORT = "capture_abort";

export interface CaptureChunk {
	type: typeof CAPTURE_CHUNK;
	captureId: string;
	index: number;
	total: number;
	text: string;
}

export interface CaptureAbort {
	type: typeof CAPTURE_ABORT;
	captureId: string;
	error: string;
}

export function* splitIntoChunks(
	captureId: string,
	text: string,
	size: number = CHUNK_SIZE,
): Iterable<CaptureChunk> {
	// One empty chunk rather than none: a zero-chunk capture never completes.
	const total = Math.max(1, Math.ceil(text.length / size));
	for (let index = 0; index < total; index++) {
		yield {
			type: CAPTURE_CHUNK,
			captureId,
			index,
			total,
			text: text.slice(index * size, (index + 1) * size),
		};
	}
}

/**
 * Deliver metadata and snapshot chunks as one abortable logical transfer.
 * Abort delivery is best-effort; the original send failure remains the cause.
 */
export async function sendCaptureTransfer(
	captureId: string,
	metadata: unknown,
	text: string,
	send: (message: unknown) => Promise<unknown>,
): Promise<void> {
	try {
		await send(metadata);
		for (const chunk of splitIntoChunks(captureId, text)) {
			await send(chunk);
		}
	} catch (error) {
		try {
			await send({
				type: CAPTURE_ABORT,
				captureId,
				error: String(error),
			} satisfies CaptureAbort);
		} catch {
			// The channel is already failing; preserve the triggering error.
		}
		throw error;
	}
}

interface CaptureBuffer {
	total: number;
	length: number;
	parts: Map<number, string>;
}

export interface ChunkAssemblerOptions {
	/** Optionally impose a stricter per-consumer aggregate limit. */
	maxTextLength?: number;
}

export class ChunkAssembler {
	private buffers = new Map<string, CaptureBuffer>();
	private readonly maxTextLength: number;

	constructor(options: ChunkAssemblerOptions = {}) {
		this.maxTextLength = Math.min(
			options.maxTextLength ?? MAX_CAPTURE_TEXT_LENGTH,
			MAX_CAPTURE_TEXT_LENGTH,
		);
	}

	/** The reassembled payload once every chunk has arrived, else null. */
	accept(chunk: CaptureChunk): string | null {
		const captureId: unknown = chunk.captureId;
		if (typeof captureId !== "string" || captureId.length === 0) {
			return this.reject(captureId, "captureId must be a non-empty string");
		}

		const existing = this.buffers.get(captureId);
		if (!Number.isSafeInteger(chunk.total) || chunk.total < 1) {
			return this.reject(captureId, "total must be a positive safe integer");
		}
		if (chunk.total > MAX_CAPTURE_CHUNKS) {
			return this.reject(
				captureId,
				`total ${chunk.total} exceeds the ${MAX_CAPTURE_CHUNKS}-chunk limit`,
			);
		}
		if (
			!Number.isSafeInteger(chunk.index) ||
			chunk.index < 0 ||
			chunk.index >= chunk.total
		) {
			return this.reject(
				captureId,
				`index ${chunk.index} must be a safe integer between 0 and ${chunk.total - 1}`,
			);
		}
		if (typeof chunk.text !== "string") {
			return this.reject(captureId, "text must be a string");
		}
		if (chunk.text.length > CHUNK_SIZE) {
			return this.reject(
				captureId,
				`chunk size ${chunk.text.length} exceeds ${CHUNK_SIZE} characters`,
			);
		}
		if (existing && existing.total !== chunk.total) {
			return this.reject(
				captureId,
				`total changed from ${existing.total} to ${chunk.total}`,
			);
		}

		const duplicate = existing?.parts.get(chunk.index);
		if (duplicate !== undefined) {
			if (duplicate === chunk.text) return null;
			return this.reject(
				captureId,
				`duplicate index ${chunk.index} has conflicting content`,
			);
		}

		const aggregateLength = (existing?.length ?? 0) + chunk.text.length;
		if (aggregateLength > this.maxTextLength) {
			return this.reject(
				captureId,
				`aggregate text length ${aggregateLength} exceeds ${this.maxTextLength} characters`,
			);
		}

		const buffer = existing ?? {
			total: chunk.total,
			length: 0,
			parts: new Map<number, string>(),
		};
		if (!existing) this.buffers.set(captureId, buffer);
		buffer.parts.set(chunk.index, chunk.text);
		buffer.length = aggregateLength;

		if (buffer.parts.size < buffer.total) return null;

		const ordered: string[] = [];
		for (let index = 0; index < buffer.total; index++) {
			ordered.push(buffer.parts.get(index) ?? "");
		}
		this.buffers.delete(captureId);
		return ordered.join("");
	}

	private reject(captureId: unknown, reason: string): never {
		if (typeof captureId === "string") this.buffers.delete(captureId);
		throw new Error(
			`Invalid capture chunk ${JSON.stringify(captureId)}: ${reason}`,
		);
	}

	/** Drop a capture that will never complete, e.g. its tab closed. */
	forget(captureId: string): void {
		this.buffers.delete(captureId);
	}

	get pending(): number {
		return this.buffers.size;
	}
}
