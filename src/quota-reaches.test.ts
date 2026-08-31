import { expect, test } from "bun:test";
import {
  reachClockSummary,
  reachHourBuckets,
  reachWeekBuckets,
} from "./quota-reaches";

const TZ = "America/New_York";

function instant(iso: string) {
  return new Date(iso).getTime();
}

test("reachWeekBuckets returns a continuous trailing strip with empty weeks kept", () => {
  const now = instant("2026-08-30T22:00:00-04:00"); // Sunday
  const reaches = [
    instant("2026-08-28T11:06:00-04:00"),
    instant("2026-08-23T11:54:00-04:00"), // Sunday: belongs to the Aug 17 week
    instant("2026-08-17T18:21:00-04:00"),
    instant("2026-07-13T09:00:00-04:00"),
  ];
  const strip = reachWeekBuckets(reaches, TZ, now, 8);
  expect(strip).toHaveLength(8);
  // Current week is Aug 24–30; strip runs oldest → newest.
  expect(strip[strip.length - 1].key).toBe("2026-08-24");
  expect(strip[strip.length - 1].count).toBe(1);
  expect(strip[strip.length - 2].key).toBe("2026-08-17");
  expect(strip[strip.length - 2].count).toBe(2);
  // The Jul 13 reach falls inside the 8-week strip.
  expect(strip[0].key).toBe("2026-07-06");
  expect(strip.find((week) => week.key === "2026-07-13")?.count).toBe(1);
  // Weeks between reaches are present with zero counts.
  expect(strip.filter((week) => week.count === 0).length).toBeGreaterThan(0);
  expect(strip[strip.length - 1].label).toBe("Aug 24");
});

test("reachWeekBuckets respects the reporting timezone at day boundaries", () => {
  // 03:00 UTC Monday is still Sunday evening in New York, so the reach
  // belongs to the week that Sunday closes, not the week the UTC Monday opens.
  const now = instant("2026-08-30T22:00:00-04:00");
  const strip = reachWeekBuckets([instant("2026-08-24T03:00:00Z")], TZ, now, 4);
  expect(strip.find((week) => week.key === "2026-08-17")?.count).toBe(1);
  expect(strip.find((week) => week.key === "2026-08-24")?.count).toBe(0);
});

test("reachHourBuckets counts wall-clock hours in the reporting timezone", () => {
  const hours = reachHourBuckets(
    [
      instant("2026-08-28T11:06:00-04:00"),
      instant("2026-08-23T11:54:00-04:00"),
      instant("2026-08-13T19:27:00-04:00"),
    ],
    TZ,
  );
  expect(hours).toHaveLength(24);
  expect(hours[11].count).toBe(2);
  expect(hours[19].count).toBe(1);
  expect(hours.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
});

test("reachClockSummary names the dominant three-hour window", () => {
  const hours = reachHourBuckets(
    [
      instant("2026-08-28T16:06:00-04:00"),
      instant("2026-08-27T17:54:00-04:00"),
      instant("2026-08-26T18:27:00-04:00"),
      instant("2026-08-25T09:00:00-04:00"),
    ],
    TZ,
  );
  expect(reachClockSummary(hours)).toBe(
    "75% of reaches land between 4p and 7p",
  );
});

test("reachClockSummary stays quiet on thin or flat data", () => {
  expect(reachClockSummary(reachHourBuckets([], TZ))).toBeNull();
  expect(
    reachClockSummary(
      reachHourBuckets(
        [instant("2026-08-28T16:06:00-04:00"), instant("2026-08-27T02:00:00-04:00")],
        TZ,
      ),
    ),
  ).toBeNull();
});
