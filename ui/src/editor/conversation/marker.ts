export type ConversationRole = "user" | "assistant";
export type ConversationOrigin = "source" | "local";

export interface ConversationMarker {
  role: ConversationRole;
  source: string;
  sequence: number | null;
  timestamp: string | null;
  origin: ConversationOrigin;
}

const SOURCE_RE = /^sha256:[0-9a-f]{64}$/;
const LOCAL_RE =
  /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MARKER_RE = /^\[!AI-(USER|ASSISTANT) ([^\]]+)\]$/;

function isValidTimestamp(value: string): boolean {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  if (monthNumber < 1 || monthNumber > 12) return false;
  const daysInMonth = new Date(
    Date.UTC(Number(year), monthNumber, 0),
  ).getUTCDate();
  if (dayNumber < 1 || dayNumber > daysInMonth) return false;
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return false;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** Parse one complete canonical conversation marker, or return null. */
export function parseConversationMarker(
  text: string,
): ConversationMarker | null {
  const markerMatch = MARKER_RE.exec(text);
  if (!markerMatch) return null;

  const role: ConversationRole =
    markerMatch[1] === "USER" ? "user" : "assistant";
  const attributes = markerMatch[2].split(" ");
  const values = new Map<string, string>();
  for (const attribute of attributes) {
    if (!attribute) return null;
    const separator = attribute.indexOf("=");
    if (separator <= 0) return null;
    const key = attribute.slice(0, separator);
    const value = attribute.slice(separator + 1);
    if (!value || values.has(key)) return null;
    values.set(key, value);
  }

  const source = values.get("source");
  if (!source) return null;
  let origin: ConversationOrigin;
  if (SOURCE_RE.test(source)) {
    origin = "source";
  } else if (LOCAL_RE.test(source)) {
    origin = "local";
  } else {
    return null;
  }

  const keys = [...values.keys()];
  const expectedKeys =
    origin === "source"
      ? [
          "source",
          "sequence",
          ...(values.has("timestamp") ? ["timestamp"] : []),
        ]
      : ["source"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }

  let sequence: number | null = null;
  let timestamp: string | null = null;
  if (origin === "source") {
    const sequenceValue = values.get("sequence");
    if (!sequenceValue || !/^[1-9]\d*$/.test(sequenceValue)) return null;
    sequence = Number(sequenceValue);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
    const timestampValue = values.get("timestamp");
    if (timestampValue !== undefined) {
      if (!isValidTimestamp(timestampValue)) return null;
      timestamp = timestampValue;
    }
  }

  return { role, source, sequence, timestamp, origin };
}

/** Format a marker using the exact canonical attribute ordering. */
export function formatConversationMarker(marker: ConversationMarker): string {
  const role = marker.role === "user" ? "USER" : "ASSISTANT";
  if (marker.origin === "local") {
    if (
      marker.sequence !== null ||
      marker.timestamp !== null ||
      !LOCAL_RE.test(marker.source)
    ) {
      throw new RangeError(
        "Local conversation markers only contain a valid local source",
      );
    }
    return `[!AI-${role} source=${marker.source}]`;
  }
  if (
    !SOURCE_RE.test(marker.source) ||
    marker.sequence === null ||
    !Number.isSafeInteger(marker.sequence) ||
    marker.sequence <= 0 ||
    (marker.timestamp !== null && !isValidTimestamp(marker.timestamp))
  ) {
    throw new RangeError(
      "Source conversation markers require a valid hash and sequence",
    );
  }
  const timestamp =
    marker.timestamp === null ? "" : ` timestamp=${marker.timestamp}`;
  return `[!AI-${role} source=${marker.source} sequence=${marker.sequence}${timestamp}]`;
}

/** Diagnose marker-looking blockquote lines without treating ordinary prose as malformed. */
export function diagnoseConversationMarkdown(markdown: string): {
  validMarkers: number;
  malformedMarkerLines: number[];
} {
  let validMarkers = 0;
  const malformedMarkerLines: number[] = [];
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!/^>\s*\[!AI-/.test(line)) return;
    const candidate = line.replace(/^>\s*/, "");
    if (parseConversationMarker(candidate)) validMarkers += 1;
    else malformedMarkerLines.push(index + 1);
  });
  return { validMarkers, malformedMarkerLines };
}
