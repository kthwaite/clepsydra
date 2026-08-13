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

export interface CaptureChunk {
	type: typeof CAPTURE_CHUNK;
	captureId: string;
	index: number;
	total: number;
	text: string;
}

export function splitIntoChunks(
	captureId: string,
	text: string,
	size: number = CHUNK_SIZE,
): CaptureChunk[] {
	// One empty chunk rather than none: a zero-chunk capture never completes.
	const total = Math.max(1, Math.ceil(text.length / size));
	const chunks: CaptureChunk[] = [];
	for (let index = 0; index < total; index++) {
		chunks.push({
			type: CAPTURE_CHUNK,
			captureId,
			index,
			total,
			text: text.slice(index * size, (index + 1) * size),
		});
	}
	return chunks;
}

export class ChunkAssembler {
	private buffers = new Map<string, Map<number, string>>();

	/** The reassembled payload once every chunk has arrived, else null. */
	accept(chunk: CaptureChunk): string | null {
		let parts = this.buffers.get(chunk.captureId);
		if (!parts) {
			parts = new Map();
			this.buffers.set(chunk.captureId, parts);
		}
		parts.set(chunk.index, chunk.text);

		if (parts.size < chunk.total) return null;

		const ordered: string[] = [];
		for (let index = 0; index < chunk.total; index++) {
			ordered.push(parts.get(index) ?? "");
		}
		this.buffers.delete(chunk.captureId);
		return ordered.join("");
	}

	/** Drop a capture that will never complete, e.g. its tab closed. */
	forget(captureId: string): void {
		this.buffers.delete(captureId);
	}

	get pending(): number {
		return this.buffers.size;
	}
}
