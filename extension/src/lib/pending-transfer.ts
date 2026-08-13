import type { CaptureChunk } from "#/lib/chunked-transfer";
import { ChunkAssembler } from "#/lib/chunked-transfer";

export const CAPTURE_INACTIVITY_TIMEOUT_MS = 30_000;
export const PENDING_TRANSFER_KEEP_ALIVE_MS = 20_000;

interface PendingTransfer<T> {
	metadata?: T;
	tabId?: number;
	cancelTimer: () => void;
}

export interface CompletedTransfer<T> {
	metadata: T | undefined;
	snapshotHtml: string;
	tabId: number | undefined;
}

interface PendingTransferCoordinatorOptions {
	assembler?: ChunkAssembler;
	inactivityMs?: number;
	/** Called on one shared interval while any transfer is pending. */
	keepAlive?: () => void;
	keepAliveMs?: number;
	onExpire: (captureId: string, tabId: number | undefined) => void;
}

/** Owns every piece of mutable state for an in-flight snapshot transfer. */
export class PendingTransferCoordinator<T> {
	private readonly assembler: ChunkAssembler;
	private readonly inactivityMs: number;
	private readonly keepAlive: (() => void) | undefined;
	private readonly keepAliveMs: number;
	private readonly onExpire: PendingTransferCoordinatorOptions["onExpire"];
	private readonly transfers = new Map<string, PendingTransfer<T>>();
	private cancelKeepAlive: (() => void) | null = null;

	constructor(options: PendingTransferCoordinatorOptions) {
		this.assembler = options.assembler ?? new ChunkAssembler();
		this.inactivityMs = options.inactivityMs ?? CAPTURE_INACTIVITY_TIMEOUT_MS;
		this.keepAlive = options.keepAlive;
		this.keepAliveMs = options.keepAliveMs ?? PENDING_TRANSFER_KEEP_ALIVE_MS;
		this.onExpire = options.onExpire;
	}

	acceptMetadata(captureId: string, metadata: T, tabId?: number): void {
		const transfer = this.resetTimer(captureId, tabId);
		transfer.metadata = metadata;
	}

	acceptChunk(
		chunk: CaptureChunk,
		tabId?: number,
	): CompletedTransfer<T> | null {
		let snapshotHtml: string | null;
		try {
			snapshotHtml = this.assembler.accept(chunk);
		} catch (error) {
			this.cleanup(chunk.captureId);
			throw error;
		}

		if (snapshotHtml === null) {
			this.resetTimer(chunk.captureId, tabId);
			return null;
		}

		const transfer = this.transfers.get(chunk.captureId);
		const completed = {
			metadata: transfer?.metadata,
			snapshotHtml,
			tabId: transfer?.tabId ?? tabId,
		};
		this.cleanup(chunk.captureId);
		return completed;
	}

	abort(captureId: string): void {
		this.cleanup(captureId);
	}

	removeTab(tabId: number): void {
		for (const [captureId, transfer] of this.transfers) {
			if (transfer.tabId === tabId) this.cleanup(captureId);
		}
	}

	get pending(): number {
		return this.transfers.size;
	}

	private resetTimer(
		captureId: string,
		tabId: number | undefined,
	): PendingTransfer<T> {
		const current = this.transfers.get(captureId);
		if (current) current.cancelTimer();

		const timer = setTimeout(() => {
			const expired = this.transfers.get(captureId);
			if (!expired) return;
			this.cleanup(captureId);
			this.onExpire(captureId, expired.tabId);
		}, this.inactivityMs);
		const transfer: PendingTransfer<T> = {
			metadata: current?.metadata,
			tabId: tabId ?? current?.tabId,
			cancelTimer: () => clearTimeout(timer),
		};
		this.transfers.set(captureId, transfer);
		this.startKeepAlive();
		return transfer;
	}

	private startKeepAlive(): void {
		if (this.cancelKeepAlive !== null || !this.keepAlive) return;
		const handle = setInterval(this.keepAlive, this.keepAliveMs);
		this.cancelKeepAlive = () => clearInterval(handle);
	}

	private cleanup(captureId: string): void {
		this.assembler.forget(captureId);
		const transfer = this.transfers.get(captureId);
		if (transfer) transfer.cancelTimer();
		this.transfers.delete(captureId);
		if (this.transfers.size > 0 || this.cancelKeepAlive === null) return;
		this.cancelKeepAlive();
		this.cancelKeepAlive = null;
	}
}
