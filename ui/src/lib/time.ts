/**
 * Convert a timestamp into a human-readable "time since" string.
 * @param timestamp - Date string or Date object.
 * @returns Human-readable duration string.
 */
export function formatRelativeTime(timestamp: string | Date): string {
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  // Less than 1 minute
  if (diffMins < 1) {
    return `${diffSecs} second${diffSecs !== 1 ? "s" : ""} ago`;
  }

  // Less than 1 hour
  if (diffHours < 1) {
    return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  }

  // Less than 24 hours
  if (diffDays < 1) {
    if (diffMins % 60 === 0) {
      // Exact hours
      return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    } else {
      // Hours and minutes
      const remainingMins = diffMins % 60;
      return `${diffHours} hour${diffHours !== 1 ? "s" : ""} and ${remainingMins} minute${remainingMins !== 1 ? "s" : ""} ago`;
    }
  }

  // More than 24 hours
  return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
}

export { formatRelativeTime as getTimeSince };

/**
 * Formats a timestamp into a human-readable format: YYYY-MM-DD HH:MM(am/pm).
 * @param timestamp - Date string or Date object.
 * @returns Formatted date string.
 */
export function humanizeTimestamp(timestamp: string | Date): string {
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;

  // Get day, month, year
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // getMonth() is 0-based
  const year = date.getFullYear();

  // Get hours in 12-hour format
  let hours = date.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  hours = hours ? hours : 12; // Convert 0 to 12

  // Get minutes
  const minutes = date.getMinutes().toString().padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}${ampm}`;
}

/**
 * Formats a timestamp into a human-readable "casual" date string.
 * @param timestamp - string timestamp.
 * @returns Formatted date string.
 */
export const humanizeTimestampCasual = (date: string): string => {
  const dateObject = new Date(date);
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  };
  return dateObject.toLocaleDateString("en-GB", options);
};

/** Formats a timestamp into a path-safe string.
 *  @param date - Date string or Date object.
 *  @returns Formatted date string.
 */
export const pathSafeTimestamp = (date: Date = new Date()): string => {
  const day = date.getDate().toString().padStart(2, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // getMonth() is 0-based
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");

  return `${year}-${month}-${day}_${hours}${minutes}`;
};

/**
 * Detects the user's timezone from browser settings
 * @returns {string} Timezone identifier (e.g., "America/New_York")
 */
export const detectUserTimezone = (): string => {
  try {
    // Get timezone from browser using Intl API
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timezone;
  } catch (e) {
    console.error("Failed to detect timezone:", e);
    // Default to UTC if detection fails
    return "UTC";
  }
};

interface GetRelativeTimeStringOptions {
  timeZone?: string;
}

/** Prints last updated date for a given timestamp.
 *  Up to 24 hours ago, will print a relative time; otherwise,
 *  will print YYYY-MM-DD HH:MM AM/PM.
 *  If not provided, will print "No updated date".
 */
export function getRelativeTimeString(
  updatedAt: number | string | Date,
  options: GetRelativeTimeStringOptions = {},
) {
  // Ensure we're working with a timestamp number
  const timestamp =
    typeof updatedAt === "object"
      ? updatedAt.getTime()
      : typeof updatedAt === "string"
        ? new Date(updatedAt).getTime()
        : Number(updatedAt);

  // Current time in UTC milliseconds
  const now = Date.now();

  // Time difference in milliseconds
  const diff = now - timestamp;

  // Default display text
  let innerText = "";

  if (diff < 1000 * 60 * 60 * 24) {
    // Less than 24 hours - show relative time
    const diffMinutes = Math.floor(diff / 1000 / 60);

    if (diffMinutes < 1) {
      const diffSeconds = Math.floor(diff / 1000);
      innerText = `Updated ${diffSeconds} second${diffSeconds === 1 ? "" : "s"} ago`;
      // innerText = "Updated just now";
    } else if (diffMinutes < 60) {
      innerText = `Updated ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
    } else {
      const diffHours = Math.floor(diffMinutes / 60);
      innerText = `Updated ${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
    }
  } else {
    // More than 24 hours - format according to user's timezone

    // Get user's timezone (or use specified timezone from options)
    const timeZone =
      options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    // Format the date in the user's timezone
    const dateFormatter = new Intl.DateTimeFormat(navigator.language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timeZone,
    });

    innerText = `Last updated ${dateFormatter.format(new Date(timestamp))}`;
  }

  return innerText;
}
