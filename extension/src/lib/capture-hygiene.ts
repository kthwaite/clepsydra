/**
 * Refuse a capture that is not worth storing.
 *
 * Adopted from gwern.net/build/linkArchive.sh, where each check encodes a
 * failure actually encountered: a snapshot truncated to nothing, and a server
 * returning its error page under HTTP 200.
 */

/** Below this a snapshot cannot contain a page, only a failure. */
const MIN_SNAPSHOT_BYTES = 1024;

/**
 * Above this much extracted article text, a marker is far likelier to be the
 * page's subject than its content. gwern greps unconditionally and accepts the
 * false positives because he reviews every capture; we do not.
 */
const ARTICLE_TEXT_FLOOR = 1500;

const ERROR_PAGE_MARKERS = [
	"403 Forbidden",
	"404 Not Found",
	"Access Denied",
	"Download Limit Exceeded",
	"Instance has been rate limited",
	"Token is required",
];

/** Why this capture must not be archived, or null to proceed. */
export function snapshotRejection(
	snapshotHtml: string,
	articleTextLength: number,
): string | null {
	if (snapshotHtml.length < MIN_SNAPSHOT_BYTES) {
		return `The capture is only ${snapshotHtml.length} bytes — under 1 KB, so it is truncated or empty rather than a page.`;
	}

	if (articleTextLength >= ARTICLE_TEXT_FLOOR) return null;

	const marker = ERROR_PAGE_MARKERS.find((m) => snapshotHtml.includes(m));
	if (marker) {
		return `The page reads as an error page ("${marker}") despite loading successfully. Nothing was archived.`;
	}

	return null;
}
