import test from "node:test";
import assert from "node:assert/strict";
import {
  ScheduleError,
  isWithinQuietHours,
  nextCronOccurrence,
  parseCron,
  previewCronOccurrences,
} from "../src/schedule/index.js";

test("parseCron validates 5-field syntax, DOW 0/7 normalization, and invalid expressions", () => {
  const parsed = parseCron("*/15 9-17 1,15 1-12/2 7");
  assert.deepEqual(parsed.minute.values, [0, 15, 30, 45]);
  assert.deepEqual(parsed.hour.values, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(parsed.dom.values, [1, 15]);
  assert.deepEqual(parsed.month.values, [1, 3, 5, 7, 9, 11]);
  assert.deepEqual(parsed.dow.values, [0]);

  const sunRange = parseCron("0 8 * * 5-7");
  assert.deepEqual(sunRange.dow.values, [0, 5, 6]);

  for (const bad of [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 0 *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "10-5 * * * *",
    "5/2 * * * *",
    "1,,2 * * * *",
    "abc * * * *",
  ]) {
    assert.throws(
      () => parseCron(bad),
      (err: unknown) =>
        err instanceof ScheduleError &&
        err.stage === "schedule.cron.parse" &&
        err.code === "ERR_INVALID_CRON",
      `Expected ERR_INVALID_CRON for "${bad}"`,
    );
  }
});

test("parseCron rejects statically impossible month+DOM dates when DOW is *", () => {
  for (const impossible of ["0 9 30 2 *", "0 9 31 2 *", "0 9 31 4 *", "0 9 31 4,6,9,11 *"]) {
    assert.throws(
      () => parseCron(impossible),
      (err: unknown) =>
        err instanceof ScheduleError &&
        err.stage === "schedule.cron.parse" &&
        err.code === "ERR_CRON_UNREACHABLE_DATE",
      `Expected ERR_CRON_UNREACHABLE_DATE for "${impossible}"`,
    );
  }

  // Restricted DOW uses POSIX OR, so 31 Feb + Monday IS reachable on Mondays in February.
  const withDow = parseCron("0 9 31 2 1");
  const next = nextCronOccurrence(withDow, new Date(2026, 1, 1, 0, 0, 0, 0));
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDay(), 1);
});

test("DOM and DOW use literal '*' unrestricted check and POSIX OR union when both restricted", () => {
  const nonWildcardDom = parseCron("0 9 */1 * 1");
  assert.equal(nonWildcardDom.dom.restricted, true);
  assert.equal(nonWildcardDom.dow.restricted, true);

  // 0 9 15 * 1 => 15th of month OR every Monday
  // 2026-11-22 is Sunday; Mondays are Nov 23, Nov 30, Dec 7, Dec 14; 15th is Tue Dec 15.
  const occurrences = previewCronOccurrences(
    "0 9 15 * 1",
    5,
    new Date(2026, 10, 22, 10, 0, 0, 0),
  );
  assert.deepEqual(
    occurrences.map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`),
    [
      "2026-11-23 9:00",
      "2026-11-30 9:00",
      "2026-12-07 9:00",
      "2026-12-14 9:00",
      "2026-12-15 9:00",
    ],
  );
});

test("calendar-field jumping crosses leap years and century non-leap year 2100 within 8-year bound", () => {
  const leapFrom2026 = nextCronOccurrence(
    "0 9 29 2 *",
    new Date(2026, 0, 1, 0, 0, 0, 0),
  );
  assert.equal(leapFrom2026.getFullYear(), 2028);
  assert.equal(leapFrom2026.getMonth(), 1);
  assert.equal(leapFrom2026.getDate(), 29);
  assert.equal(leapFrom2026.getHours(), 9);
  assert.equal(leapFrom2026.getMinutes(), 0);

  // Year 2100 is divisible by 100 and NOT 400 => not a leap year; 2096 jumps directly to 2104-02-29.
  const leapAcross2100 = nextCronOccurrence(
    "0 9 29 2 *",
    new Date(2096, 1, 29, 9, 0, 0, 0),
  );
  assert.equal(leapAcross2100.getFullYear(), 2104);
  assert.equal(leapAcross2100.getMonth(), 1);
  assert.equal(leapAcross2100.getDate(), 29);
  assert.equal(leapAcross2100.getHours(), 9);
  assert.equal(leapAcross2100.getMinutes(), 0);

  // Search bound overflow throws stage schedule.cron.next + ERR_CRON_UNREACHABLE_DATE.
  assert.throws(
    () =>
      nextCronOccurrence("0 9 29 2 *", new Date(2026, 0, 1, 0, 0, 0, 0), {
        maxYears: 1,
      }),
    (err: unknown) =>
      err instanceof ScheduleError &&
      err.stage === "schedule.cron.next" &&
      err.code === "ERR_CRON_UNREACHABLE_DATE",
  );
});

test("nextCronOccurrence handles spring-forward skipped hour and fall-back repeated hour in DST timezone", () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    // Spring forward: 2026-03-08 jumps from 01:59 EST directly to 03:00 EDT (02:30 does not exist).
    const skipped = nextCronOccurrence("30 2 * * *", new Date(2026, 2, 8, 0, 0, 0, 0));
    assert.equal(skipped.getFullYear(), 2026);
    assert.equal(skipped.getMonth(), 2);
    assert.equal(skipped.getDate(), 9);
    assert.equal(skipped.getHours(), 2);
    assert.equal(skipped.getMinutes(), 30);

    // Every 15 minutes across spring forward: 01:45 EST -> 03:00 EDT (15 real minutes later).
    const quarterAfterSpring = nextCronOccurrence(
      "*/15 * * * *",
      new Date(2026, 2, 8, 1, 45, 0, 0),
    );
    assert.equal(quarterAfterSpring.getHours(), 3);
    assert.equal(quarterAfterSpring.getMinutes(), 0);

    // Fall back: 2026-11-01 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST).
    // Daily fixed-hour job 30 1 * * * fires once on Nov 1 (01:30 EDT) then moves to Nov 2.
    const fallFirst = nextCronOccurrence("30 1 * * *", new Date(2026, 10, 1, 0, 30, 0, 0));
    assert.equal(fallFirst.toISOString(), "2026-11-01T05:30:00.000Z");
    const fallNext = nextCronOccurrence("30 1 * * *", fallFirst);
    assert.equal(fallNext.getDate(), 2);

    // Wildcard-hour job 0 * * * * fires every real hour (01:00 EDT = 05:00Z -> 01:00 EST = 06:00Z -> 02:00 EST = 07:00Z).
    const hourly1 = nextCronOccurrence("0 * * * *", new Date("2026-11-01T05:00:00.000Z"));
    assert.equal(hourly1.toISOString(), "2026-11-01T06:00:00.000Z");
    const hourly2 = nextCronOccurrence("0 * * * *", hourly1);
    assert.equal(hourly2.toISOString(), "2026-11-01T07:00:00.000Z");
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test("isWithinQuietHours handles multi-window union and cross-midnight yesterday weekday rollback", () => {
  const settings = {
    quietHoursEnabled: true,
    quietHours: [
      {
        id: "night-weekdays",
        label: "Weekday Nights",
        startMinute: 23 * 60,
        endMinute: 8 * 60,
        daysOfWeek: [1, 2, 3, 4, 5],
        enabled: true,
      },
      {
        id: "nap",
        label: "Afternoon Nap",
        startMinute: 12 * 60 + 30,
        endMinute: 13 * 60 + 30,
        enabled: true,
      },
      {
        id: "disabled-all-day",
        startMinute: 0,
        endMinute: 23 * 60 + 59,
        enabled: false,
      },
    ],
  };

  // Master switch off => always false
  assert.equal(
    isWithinQuietHours(new Date(2026, 10, 23, 23, 30), {
      ...settings,
      quietHoursEnabled: false,
    }),
    false,
  );

  // Monday 22:59 => false; Monday 23:00 => true
  assert.equal(isWithinQuietHours(new Date(2026, 10, 23, 22, 59), settings), false);
  assert.equal(isWithinQuietHours(new Date(2026, 10, 23, 23, 0), settings), true);

  // Friday 23:30 (dow=5) => true
  assert.equal(isWithinQuietHours(new Date(2026, 10, 27, 23, 30), settings), true);
  // Saturday 07:59 (dow=6, yesterday=5 Friday!) => true due to yesterday weekday rollback
  assert.equal(isWithinQuietHours(new Date(2026, 10, 28, 7, 59), settings), true);
  // Saturday 08:00 (end boundary exclusive) => false
  assert.equal(isWithinQuietHours(new Date(2026, 10, 28, 8, 0), settings), false);
  // Saturday 23:30 (dow=6 not in Mon-Fri) => false
  assert.equal(isWithinQuietHours(new Date(2026, 10, 28, 23, 30), settings), false);
  // Sunday 07:59 (dow=0, yesterday=6 Saturday not in Mon-Fri) => false
  assert.equal(isWithinQuietHours(new Date(2026, 10, 29, 7, 59), settings), false);
  // Monday 07:59 (dow=1, yesterday=0 Sunday not in Mon-Fri) => false
  assert.equal(isWithinQuietHours(new Date(2026, 10, 23, 7, 59), settings), false);
  // Second active window union: Sunday 12:45 => true
  assert.equal(isWithinQuietHours(new Date(2026, 10, 29, 12, 45), settings), true);
});
