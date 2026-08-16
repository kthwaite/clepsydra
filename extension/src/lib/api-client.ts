import type {
	ArchiveLookupResponse,
	ArchiveManifest,
	ArchiveResponse,
	ArchiveStatusResponse,
} from "./types";

export class ClepsydraClient {
	constructor(private baseUrl: string) {}

	async ingestArchive(manifest: ArchiveManifest): Promise<ArchiveResponse> {
		const res = await fetch(`${this.baseUrl}/api/vault/archive`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(manifest),
		});

		if (res.status === 200 || res.status === 201) {
			return res.json();
		}
		if (res.status === 409) {
			const body = await res.json();
			throw new ArchiveConflictError(body);
		}
		throw new ArchiveError(
			`Server returned ${res.status}: ${await res.text()}`,
		);
	}

	async getStatus(): Promise<ArchiveStatusResponse> {
		const res = await fetch(`${this.baseUrl}/api/vault/archive/status`);
		if (!res.ok) {
			throw new ArchiveError(`Status check failed: ${res.status}`);
		}
		return res.json();
	}

	async lookupArchive(url: string): Promise<ArchiveLookupResponse> {
		const res = await fetch(
			`${this.baseUrl}/api/vault/archive/lookup?url=${encodeURIComponent(url)}`,
		);
		if (!res.ok) {
			throw new ArchiveError(`Lookup failed: ${res.status}`);
		}
		return res.json();
	}

	async isReachable(): Promise<boolean> {
		try {
			await this.getStatus();
			return true;
		} catch {
			return false;
		}
	}
}

export class ArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveError";
	}
}

export class ArchiveConflictError extends ArchiveError {
	constructor(public detail: unknown) {
		super("URL already archived with different content");
		this.name = "ArchiveConflictError";
	}
}
