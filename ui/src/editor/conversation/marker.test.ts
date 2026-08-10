import { describe, expect, it } from "vitest";
import {
  diagnoseConversationMarkdown,
  formatConversationMarker,
  parseConversationMarker,
} from "./marker";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("conversation marker grammar", () => {
  it("parses source user and assistant markers with optional timestamp", () => {
    expect(
      parseConversationMarker(
        `[!AI-USER source=sha256:${HASH} sequence=1]`,
      ),
    ).toEqual({
      role: "user",
      source: `sha256:${HASH}`,
      sequence: 1,
      timestamp: null,
      origin: "source",
    });
    expect(
      parseConversationMarker(
        `[!AI-ASSISTANT source=sha256:${HASH} sequence=2 timestamp=2026-08-09T09:14:00Z]`,
      ),
    ).toEqual({
      role: "assistant",
      source: `sha256:${HASH}`,
      sequence: 2,
      timestamp: "2026-08-09T09:14:00Z",
      origin: "source",
    });
  });

  it("parses local markers without sequence or timestamp", () => {
    expect(
      parseConversationMarker(`[!AI-USER source=local:${UUID}]`),
    ).toEqual({
      role: "user",
      source: `local:${UUID}`,
      sequence: null,
      timestamp: null,
      origin: "local",
    });
  });

  it("rejects malformed, non-canonical, or extra attributes", () => {
    const invalid = [
      `[!AI-USER source=sha256:${HASH.toUpperCase()} sequence=1]`,
      `[!AI-USER source=sha256:${HASH} sequence=0]`,
      `[!AI-USER source=sha256:${HASH} sequence=-1]`,
      `[!AI-USER source=local:${UUID} sequence=1]`,
      `[!AI-USER source=sha256:${HASH} sequence=1 sequence=2]`,
      `[!AI-USER sequence=1 source=sha256:${HASH}]`,
      `[!AI-USER source=sha256:${HASH} sequence=1 extra=x]`,
      `[!AI-SYSTEM source=sha256:${HASH} sequence=1]`,
      `[!AI-USER source=sha256:${HASH} sequence=1 timestamp=not-a-date]`,
      `prefix [!AI-USER source=sha256:${HASH} sequence=1]`,
    ];
    for (const marker of invalid) expect(parseConversationMarker(marker)).toBeNull();
  });

  it("formats canonical markers", () => {
    expect(
      formatConversationMarker({
        role: "assistant",
        source: `sha256:${HASH}`,
        sequence: 2,
        timestamp: "2026-08-09T09:14:00Z",
        origin: "source",
      }),
    ).toBe(
      `[!AI-ASSISTANT source=sha256:${HASH} sequence=2 timestamp=2026-08-09T09:14:00Z]`,
    );
    expect(
      formatConversationMarker({
        role: "user",
        source: `local:${UUID}`,
        sequence: null,
        timestamp: null,
        origin: "local",
      }),
    ).toBe(`[!AI-USER source=local:${UUID}]`);
  });

  it("diagnoses only marker candidate blockquote lines", () => {
    const markdown = [
      "> [!AI-USER source=sha256:" + HASH + " sequence=1]",
      "> [!AI-ASSISTANT source=sha256:not-a-hash sequence=2]",
      "A paragraph containing [!AI-USER source=noise] is ordinary prose.",
      "> ordinary quote [!AI-USER source=noise]",
    ].join("\n");
    expect(diagnoseConversationMarkdown(markdown)).toEqual({
      validMarkers: 1,
      malformedMarkerLines: [2],
    });
  });
});
