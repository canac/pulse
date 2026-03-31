import { BUSINESS_HOURS } from "./config.ts";

const { start: BH_START, end: BH_END, tz: TZ } = BUSINESS_HOURS;
const HOURS_PER_DAY = BH_END - BH_START;

/** Returns true if the given day-of-week is a weekend (Saturday=6, Sunday=7). */
function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 6 || dayOfWeek === 7;
}

/**
 * Advance a ZonedDateTime to the start of the next business day at BH_START.
 * "Next business day" means skip weekends.
 */
function nextBusinessDayStart(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  let candidate = zdt.with({ hour: BH_START, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }).add({ days: 1 });
  while (isWeekend(candidate.dayOfWeek)) {
    candidate = candidate.add({ days: 1 });
  }
  return candidate;
}

/**
 * Clamp a start ZonedDateTime forward into business hours.
 * - If on a weekend or after BH_END, advance to the next business day at BH_START.
 * - If before BH_START on a business day, clamp to BH_START of that same day.
 * - If within business hours, return as-is (only hour precision matters).
 */
function clampStart(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  const hourDecimal = zdt.hour + zdt.minute / 60 + zdt.second / 3600;

  if (isWeekend(zdt.dayOfWeek)) {
    // Advance to the following Monday at BH_START
    let candidate = zdt.with({ hour: BH_START, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    while (isWeekend(candidate.dayOfWeek)) {
      candidate = candidate.add({ days: 1 });
    }
    return candidate;
  }

  if (hourDecimal >= BH_END) {
    // After close — move to next business day open
    return nextBusinessDayStart(zdt);
  }

  if (hourDecimal < BH_START) {
    // Before open — clamp to open of the same day
    return zdt.with({ hour: BH_START, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  }

  return zdt;
}

/**
 * Clamp an end ZonedDateTime backward into business hours.
 * - If on a weekend or before BH_START, retreat to the previous business day at BH_END.
 * - If after BH_END on a business day, clamp to BH_END of that same day.
 * - If within business hours, return as-is.
 */
function clampEnd(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  const hourDecimal = zdt.hour + zdt.minute / 60 + zdt.second / 3600;

  if (isWeekend(zdt.dayOfWeek)) {
    // Retreat to the previous Friday (or last business day) at BH_END
    let candidate = zdt.with({ hour: BH_END, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
    while (isWeekend(candidate.dayOfWeek)) {
      candidate = candidate.subtract({ days: 1 });
    }
    return candidate;
  }

  if (hourDecimal <= BH_START) {
    // At or before open — retreat to previous business day close
    let candidate = zdt.with({ hour: BH_END, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 }).subtract({ days: 1 });
    while (isWeekend(candidate.dayOfWeek)) {
      candidate = candidate.subtract({ days: 1 });
    }
    return candidate;
  }

  if (hourDecimal > BH_END) {
    // After close — clamp to close of the same day
    return zdt.with({ hour: BH_END, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  }

  return zdt;
}

/** Count how many full business days exist strictly between two calendar dates (exclusive). */
function fullBusinessDaysBetween(
  startZoned: Temporal.ZonedDateTime,
  endZoned: Temporal.ZonedDateTime,
): number {
  let count = 0;
  // Start from the day after startZoned's date, stop before endZoned's date
  let currentDay = startZoned.add({ days: 1 }).with({
    hour: BH_START, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0,
  });

  // Compare calendar dates only
  while (
    Temporal.PlainDate.compare(
      currentDay.toPlainDate(),
      endZoned.toPlainDate(),
    ) < 0
  ) {
    if (!isWeekend(currentDay.dayOfWeek)) {
      count++;
    }
    currentDay = currentDay.add({ days: 1 });
  }
  return count;
}

/**
 * Calculates the number of business hours elapsed between two instants.
 * Business hours are defined in config.ts (10am–4pm ET, Monday–Friday).
 * Returns 0 if end is before or equal to start after clamping.
 */
export function businessHoursElapsed(
  startInstant: Temporal.Instant,
  endInstant: Temporal.Instant,
): number {
  // Return 0 immediately if end is not after start
  if (Temporal.Instant.compare(endInstant, startInstant) <= 0) {
    return 0;
  }

  const startZoned = startInstant.toZonedDateTimeISO(TZ);
  const endZoned = endInstant.toZonedDateTimeISO(TZ);

  const clampedStart = clampStart(startZoned);
  const clampedEnd = clampEnd(endZoned);

  // After clamping, if end is not after start, return 0
  if (Temporal.ZonedDateTime.compare(clampedEnd, clampedStart) <= 0) {
    return 0;
  }

  const startDate = clampedStart.toPlainDate();
  const endDate = clampedEnd.toPlainDate();
  const sameDayComparison = Temporal.PlainDate.compare(startDate, endDate);

  if (sameDayComparison === 0) {
    // Same calendar day: just subtract the hours
    const startHour = clampedStart.hour + clampedStart.minute / 60 + clampedStart.second / 3600;
    const endHour = clampedEnd.hour + clampedEnd.minute / 60 + clampedEnd.second / 3600;
    return Math.max(0, endHour - startHour);
  }

  // Different days: partial first day + full middle days + partial last day
  const startHour = clampedStart.hour + clampedStart.minute / 60 + clampedStart.second / 3600;
  const endHour = clampedEnd.hour + clampedEnd.minute / 60 + clampedEnd.second / 3600;

  const hoursOnStartDay = BH_END - startHour;
  const hoursOnEndDay = endHour - BH_START;
  const fullMiddleDays = fullBusinessDaysBetween(clampedStart, clampedEnd);
  const totalHours = hoursOnStartDay + fullMiddleDays * HOURS_PER_DAY + hoursOnEndDay;

  return Math.max(0, totalHours);
}
