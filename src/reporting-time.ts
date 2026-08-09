type Timestamp = string | Date;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function timestamp(value: unknown) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatter(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const existing = cache.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
  cache.set(timeZone, created);
  return created;
}

/** The IANA timezone used for every reporting boundary in the current process. */
export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Converts an instant into the calendar key used by ccusage and AIUO's derived data. */
export function dateKeyInTimeZone(value: unknown, timeZone = systemTimeZone()): string | null {
  const date = timestamp(value);
  if (!date) return null;
  try {
    const parts = formatter(dateFormatters, timeZone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

/** Returns the wall-clock hour for an instant in the reporting timezone. */
export function hourInTimeZone(value: Timestamp, timeZone = systemTimeZone()): number | null {
  const date = timestamp(value);
  if (!date) return null;
  try {
    const hour = formatter(hourFormatters, timeZone, {
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).find((item) => item.type === "hour")?.value;
    const parsed = Number(hour);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : null;
  } catch {
    return null;
  }
}
