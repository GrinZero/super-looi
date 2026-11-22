import { ScheduleError, type ScheduleSettings } from "./types.js";

export interface ParsedCronField {
  readonly values: readonly number[];
  readonly set: ReadonlySet<number>;
  /** True for any expression other than literal "*". */
  readonly restricted: boolean;
}

export interface ParsedCron {
  readonly expr: string;
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dom: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dow: ParsedCronField;
}

const MAX_DAYS_BY_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const DEFAULT_MAX_SEARCH_YEARS = 8;

function invalidCron(reason: string): never {
  throw new ScheduleError({
    stage: "schedule.cron.parse",
    code: "ERR_INVALID_CRON",
    reason,
  });
}

function parseIntegerToken(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw)) {
    invalidCron(`Invalid integer "${raw}" in ${fieldName} field`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    invalidCron(`Integer out of bounds "${raw}" in ${fieldName} field`);
  }
  return value;
}

function parseField(
  token: string,
  fieldName: string,
  min: number,
  max: number,
  normalize?: (value: number) => number,
): ParsedCronField {
  if (!token) {
    invalidCron(`Empty ${fieldName} field`);
  }
  const restricted = token !== "*";
  const valueSet = new Set<number>();
  const items = token.split(",");

  for (const item of items) {
    if (!item) {
      invalidCron(`Empty list entry in ${fieldName} field: "${token}"`);
    }
    const slashParts = item.split("/");
    if (slashParts.length > 2) {
      invalidCron(`Invalid step syntax "${item}" in ${fieldName} field`);
    }
    const rangeExpr = slashParts[0]!;
    let step = 1;
    if (slashParts.length === 2) {
      step = parseIntegerToken(slashParts[1]!, fieldName);
      if (step < 1) {
        invalidCron(`Step must be >= 1 in ${fieldName} field: "${item}"`);
      }
    }

    let start: number;
    let end: number;
    if (rangeExpr === "*") {
      start = min;
      end = max;
    } else if (rangeExpr.includes("-")) {
      const bounds = rangeExpr.split("-");
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) {
        invalidCron(`Invalid range "${rangeExpr}" in ${fieldName} field`);
      }
      start = parseIntegerToken(bounds[0], fieldName);
      end = parseIntegerToken(bounds[1], fieldName);
      if (start < min || end > max || start > end) {
        invalidCron(`Range "${rangeExpr}" out of [${min}, ${max}] in ${fieldName} field`);
      }
    } else {
      if (slashParts.length === 2) {
        invalidCron(`Step requires wildcard or range in ${fieldName} field: "${item}"`);
      }
      start = parseIntegerToken(rangeExpr, fieldName);
      end = start;
      if (start < min || end > max) {
        invalidCron(`Value ${start} out of [${min}, ${max}] in ${fieldName} field`);
      }
    }

    for (let value = start; value <= end; value += step) {
      valueSet.add(normalize ? normalize(value) : value);
    }
  }

  const values = [...valueSet].sort((a, b) => a - b);
  if (values.length === 0) {
    invalidCron(`No valid values resolved for ${fieldName} field: "${token}"`);
  }
  return { values, set: valueSet, restricted };
}

/**
 * Parse a standard 5-field Cron expression (`minute hour dom month dow`).
 * Literal `*` is the only unrestricted marker; restricted DOM + DOW use POSIX OR semantics.
 */
export function parseCron(expr: string): ParsedCron {
  const trimmed = expr.trim();
  if (!trimmed) {
    invalidCron("Cron expression cannot be empty");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    invalidCron(`Expected 5 cron fields, got ${parts.length}`);
  }

  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseField(minuteRaw, "minute", 0, 59);
  const hour = parseField(hourRaw, "hour", 0, 23);
  const dom = parseField(domRaw, "dayOfMonth", 1, 31);
  const month = parseField(monthRaw, "month", 1, 12);
  const dow = parseField(dowRaw, "dayOfWeek", 0, 7, (value) => (value === 7 ? 0 : value));

  if (!dow.restricted) {
    const hasReachableDay = month.values.some((m) =>
      dom.values.some((d) => d <= MAX_DAYS_BY_MONTH[m]!),
    );
    if (!hasReachableDay) {
      throw new ScheduleError({
        stage: "schedule.cron.parse",
        code: "ERR_CRON_UNREACHABLE_DATE",
        reason: `Cron expression "${trimmed}" has no valid calendar day across allowed months`,
      });
    }
  }

  return { expr: trimmed, minute, hour, dom, month, dow };
}

function dayMatches(parsed: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatch = parsed.dom.set.has(dayOfMonth);
  const dowMatch = parsed.dow.set.has(dayOfWeek);
  if (parsed.dom.restricted && parsed.dow.restricted) {
    return domMatch || dowMatch;
  }
  if (parsed.dom.restricted) {
    return domMatch;
  }
  if (parsed.dow.restricted) {
    return dowMatch;
  }
  return true;
}

function resolveCandidateDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  startMs: number,
  startOffsetMinutes: number,
  hourRestricted: boolean,
): Date | undefined {
  const first = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    first.getFullYear() !== year ||
    first.getMonth() !== month - 1 ||
    first.getDate() !== day ||
    first.getHours() !== hour ||
    first.getMinutes() !== minute
  ) {
    // Wall clock minute skipped by spring-forward DST transition.
    return undefined;
  }
  if (first.getTime() >= startMs) {
    return first;
  }
  // Check whether wall clock hour repeats due to fall-back DST transition.
  const firstOffset = first.getTimezoneOffset();
  const candidateOffsets = firstOffset !== startOffsetMinutes
    ? [startOffsetMinutes - firstOffset]
    : !hourRestricted
      ? [30, 60]
      : [];
  for (const deltaMinutes of candidateOffsets) {
    if (deltaMinutes <= 0) continue;
    const second = new Date(first.getTime() + deltaMinutes * 60_000);
    if (
      second.getTime() >= startMs &&
      second.getFullYear() === year &&
      second.getMonth() === month - 1 &&
      second.getDate() === day &&
      second.getHours() === hour &&
      second.getMinutes() === minute
    ) {
      return second;
    }
  }
  return undefined;
}

/**
 * Evaluate the next valid local-time occurrence strictly after `after` using
 * calendar-field jumping (`year -> month -> day -> hour -> minute`) within 8 years.
 */
export function nextCronOccurrence(
  exprOrParsed: string | ParsedCron,
  after: Date = new Date(),
  options?: { maxYears?: number },
): Date {
  const parsed = typeof exprOrParsed === "string" ? parseCron(exprOrParsed) : exprOrParsed;
  const maxYears = options?.maxYears ?? DEFAULT_MAX_SEARCH_YEARS;
  const startMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const startDate = new Date(startMs);
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth() + 1;
  const startDay = startDate.getDate();
  const startHour = startDate.getHours();
  const startOffset = startDate.getTimezoneOffset();
  const maxTimeMs = new Date(
    startYear + maxYears,
    startDate.getMonth(),
    startDay,
    startHour,
    startDate.getMinutes(),
    0,
    0,
  ).getTime();

  const unreachable = (): never => {
    throw new ScheduleError({
      stage: "schedule.cron.next",
      code: "ERR_CRON_UNREACHABLE_DATE",
      reason: `No occurrence found for "${parsed.expr}" within ${maxYears} years`,
    });
  };

  for (let year = startYear; year <= startYear + maxYears; year++) {
    const minMonth = year === startYear ? startMonth : 1;
    for (const month of parsed.month.values) {
      if (month < minMonth) continue;
      const daysInMonth = new Date(year, month, 0).getDate();
      const minDay = year === startYear && month === startMonth ? startDay : 1;
      for (let day = minDay; day <= daysInMonth; day++) {
        // Use local noon to query weekday without DST midnight boundary distortion.
        const dow = new Date(year, month - 1, day, 12, 0, 0, 0).getDay();
        if (!dayMatches(parsed, day, dow)) continue;

        const minHour =
          year === startYear && month === startMonth && day === startDay
            ? Math.max(0, startHour - 1)
            : 0;
        for (const hour of parsed.hour.values) {
          if (hour < minHour) continue;
          for (const minute of parsed.minute.values) {
            const candidate = resolveCandidateDate(
              year,
              month,
              day,
              hour,
              minute,
              startMs,
              startOffset,
              parsed.hour.restricted,
            );
            if (!candidate) continue;
            if (candidate.getTime() > maxTimeMs) {
              return unreachable();
            }
            return candidate;
          }
        }
      }
    }
  }

  return unreachable();
}

export function previewCronOccurrences(
  expr: string,
  count = 5,
  after: Date = new Date(),
  options?: { maxYears?: number },
): Date[] {
  const parsed = parseCron(expr);
  const results: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextCronOccurrence(parsed, cursor, options);
    results.push(next);
    cursor = next;
  }
  return results;
}

/**
 * Check whether `now` (in local wall-clock time) falls within any enabled quiet window.
 * Cross-midnight windows (`startMinute > endMinute`) roll `00:00..endMinute` back to
 * yesterday's weekday when checking `daysOfWeek`.
 */
export function isWithinQuietHours(
  now: Date,
  settings: Pick<ScheduleSettings, "quietHoursEnabled" | "quietHours">,
): boolean {
  if (!settings.quietHoursEnabled) return false;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const todayDow = now.getDay();
  const yesterdayDow = (todayDow + 6) % 7;

  for (const window of settings.quietHours) {
    if (!window.enabled) continue;
    if (window.startMinute === window.endMinute) continue;

    const days = window.daysOfWeek && window.daysOfWeek.length > 0
      ? window.daysOfWeek.map((d) => (d === 7 ? 0 : d))
      : undefined;
    const matchesDay = (dow: number) => !days || days.includes(dow);

    if (window.startMinute < window.endMinute) {
      if (
        matchesDay(todayDow) &&
        minuteOfDay >= window.startMinute &&
        minuteOfDay < window.endMinute
      ) {
        return true;
      }
    } else {
      if (matchesDay(todayDow) && minuteOfDay >= window.startMinute) {
        return true;
      }
      if (matchesDay(yesterdayDow) && minuteOfDay < window.endMinute) {
        return true;
      }
    }
  }

  return false;
}
