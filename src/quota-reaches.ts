import { dateKeyInTimeZone, hourInTimeZone, systemTimeZone } from "./reporting-time";

export type ReachWeekBucket = {
  /** Calendar key (YYYY-MM-DD) of the Monday opening the week, in the reporting timezone. */
  key: string;
  /** Short label for the week's Monday, e.g. "Aug 24". */
  label: string;
  count: number;
};

export type ReachHourBucket = { hour: number; count: number };

function mondayKeyOf(dateKey: string): string {
  // The key is already a timezone-resolved calendar date, so UTC math on it is safe.
  const date = new Date(`${dateKey}T00:00:00Z`);
  const day = date.getUTCDay();
  const back = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

function weekLabel(mondayKey: string): string {
  const date = new Date(`${mondayKey}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A continuous strip of the trailing `weeks` calendar weeks (oldest first), each
 * carrying how many quota reaches landed in it. Empty weeks stay in the strip so
 * a change in cadence is visible as a change in bar height, not a missing bar. */
export function reachWeekBuckets(
  reachedAt: number[],
  timeZone = systemTimeZone(),
  now = Date.now(),
  weeks = 8,
): ReachWeekBucket[] {
  const nowKey = dateKeyInTimeZone(new Date(now).toISOString(), timeZone);
  if (!nowKey) return [];
  const currentMonday = mondayKeyOf(nowKey);
  const counts = new Map<string, number>();
  for (const instant of reachedAt) {
    const key = dateKeyInTimeZone(new Date(instant).toISOString(), timeZone);
    if (!key) continue;
    const monday = mondayKeyOf(key);
    counts.set(monday, (counts.get(monday) ?? 0) + 1);
  }
  const strip: ReachWeekBucket[] = [];
  const cursor = new Date(`${currentMonday}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 7 * (weeks - 1));
  for (let index = 0; index < weeks; index++) {
    const key = cursor.toISOString().slice(0, 10);
    strip.push({ key, label: weekLabel(key), count: counts.get(key) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return strip;
}

/** Reaches by wall-clock hour in the reporting timezone — 24 buckets, hour 0 first. */
export function reachHourBuckets(
  reachedAt: number[],
  timeZone = systemTimeZone(),
): ReachHourBucket[] {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const instant of reachedAt) {
    const hour = hourInTimeZone(new Date(instant), timeZone);
    if (hour !== null) buckets[hour].count += 1;
  }
  return buckets;
}

/** One sentence summarizing the clock pattern, or null when there is no signal.
 * Uses a centered three-hour window so "around 5 PM" absorbs 4-6 PM reaches. */
export function reachClockSummary(
  hours: ReachHourBucket[],
  minimum = 3,
): string | null {
  const total = hours.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total < minimum) return null;
  let bestStart = 0;
  let bestCount = -1;
  for (let start = 0; start < 24; start++) {
    const count =
      hours[start].count +
      hours[(start + 1) % 24].count +
      hours[(start + 2) % 24].count;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  if (bestCount <= 0) return null;
  const share = Math.round((bestCount / total) * 100);
  if (share < 34) return null;
  const format = (hour: number) => {
    const normalized = ((hour % 24) + 24) % 24;
    const suffix = normalized < 12 ? "a" : "p";
    const twelve = normalized % 12 === 0 ? 12 : normalized % 12;
    return `${twelve}${suffix}`;
  };
  return `${share}% of reaches land between ${format(bestStart)} and ${format(bestStart + 3)}`;
}
