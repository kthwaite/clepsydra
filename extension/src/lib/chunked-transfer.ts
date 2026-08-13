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
	parts: Map<number, string>;
}

export class ChunkAssembler {
	private buffers = new Map<string, CaptureBuffer>();

	/** The reassembled payload once every chunk has arrived, else null. */
	accept(chunk: CaptureChunk): string | null {
		const existing = this.buffers.get(chunk.captureId);

		if (!Number.isInteger(chunk.total) || chunk.total < 1) {
			return this.reject(chunk.captureId, "total must be a positive integer");
		}
		if (
			!Number.isInteger(chunk.index) ||
			chunk.index < 0 ||
			chunk.index >= chunk.total
		) {
			return this.reject(
				chunk.captureId,
				`index ${chunk.index} must be an integer between 0 and ${chunk.total - 1}`,
			);
		}
		if (chunk.text.length > CHUNK_SIZE) {
			return this.reject(
				chunk.captureId,
				`chunk size ${chunk.text.length} exceeds ${CHUNK_SIZE} characters`,
			);
		}
		if (existing && existing.total !== chunk.total) {
			return this.reject(
				chunk.captureId,
				`total changed from ${existing.total} to ${chunk.total}`,
			);
		}

		const duplicate = existing?.parts.get(chunk.index);
		if (duplicate !== undefined) {
			if (duplicate === chunk.text) return null;
			return this.reject(
				chunk.captureId,
				`duplicate index ${chunk.index} has conflicting content`,
			);
		}

		const buffer = existing ?? {
			total: chunk.total,
			parts: new Map<number, string>(),
		};
		if (!existing) this.buffers.set(chunk.captureId, buffer);
		buffer.parts.set(chunk.index, chunk.text);

		if (buffer.parts.size < buffer.total) return null;

		const ordered: string[] = [];
		for (let index = 0; index < buffer.total; index++) {
			ordered.push(buffer.parts.get(index) ?? "");
		}
		this.buffers.delete(chunk.captureId);
		return ordered.join("");
	}

	private reject(captureId: string, reason: string): never {
		this.buffers.delete(captureId);
		throw new Error(`Invalid capture chunk "${captureId}": ${reason}`);
	}

	/** Drop a capture that will never complete, e.g. its tab closed. */
	forget(captureId: string): void {
		this.buffers.delete(captureId);
	}

	get pending(): number {
		return this.buffers.size;
	}
}
