import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { businessHoursElapsed } from "./business-hours.ts";

function instant(isoString: string): Temporal.Instant {
  return Temporal.Instant.from(isoString);
}

describe("businessHoursElapsed", () => {
  it("same business day", () => {
    // Monday March 30 2026, 11am → 2pm ET (EDT = UTC-4)
    const result = businessHoursElapsed(
      instant("2026-03-30T15:00:00Z"), // 11am ET
      instant("2026-03-30T18:00:00Z"), // 2pm ET
    );
    assertEquals(result, 3);
  });

  it("across a single night", () => {
    // Monday 3pm ET → Tuesday 11am ET = 1h Monday + 1h Tuesday = 2h
    const result = businessHoursElapsed(
      instant("2026-03-30T19:00:00Z"), // Monday 3pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 2);
  });

  it("across a weekend", () => {
    // Friday 2pm ET → Monday 11am ET = 2h Friday + 1h Monday = 3h
    const result = businessHoursElapsed(
      instant("2026-03-27T18:00:00Z"), // Friday 2pm ET
      instant("2026-03-30T15:00:00Z"), // Monday 11am ET
    );
    assertEquals(result, 3);
  });

  it("start before business hours", () => {
    // Monday 8am ET → Monday 2pm ET = clamped to 10am, so 4h
    const result = businessHoursElapsed(
      instant("2026-03-30T12:00:00Z"), // 8am ET
      instant("2026-03-30T18:00:00Z"), // 2pm ET
    );
    assertEquals(result, 4);
  });

  it("start after business hours", () => {
    // Monday 5pm ET → Tuesday 11am ET = clamped to Tue 10am, so 1h
    const result = businessHoursElapsed(
      instant("2026-03-30T21:00:00Z"), // Monday 5pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 1);
  });

  it("start on weekend", () => {
    // Saturday 12pm ET → Monday 2pm ET = clamped to Mon 10am, so 4h
    const result = businessHoursElapsed(
      instant("2026-03-28T16:00:00Z"), // Saturday 12pm ET
      instant("2026-03-30T18:00:00Z"), // Monday 2pm ET
    );
    assertEquals(result, 4);
  });

  it("end after business hours clamps to close", () => {
    // Monday 10am ET → Monday 7pm ET = clamped to 4pm, so 6h
    const result = businessHoursElapsed(
      instant("2026-03-30T14:00:00Z"), // Monday 10am ET
      instant("2026-03-30T23:00:00Z"), // Monday 7pm ET
    );
    assertEquals(result, 6);
  });

  it("multi-day span", () => {
    // Monday 10am ET → Wednesday 4pm ET = 6 + 6 + 6 = 18h
    const result = businessHoursElapsed(
      instant("2026-03-30T14:00:00Z"), // Monday 10am ET
      instant("2026-04-01T20:00:00Z"), // Wednesday 4pm ET
    );
    assertEquals(result, 18);
  });

  it("both on weekend returns zero", () => {
    const result = businessHoursElapsed(
      instant("2026-03-28T14:00:00Z"), // Saturday
      instant("2026-03-29T14:00:00Z"), // Sunday
    );
    assertEquals(result, 0);
  });

  it("end before start returns zero", () => {
    const result = businessHoursElapsed(
      instant("2026-03-30T18:00:00Z"), // Monday 2pm ET
      instant("2026-03-30T15:00:00Z"), // Monday 11am ET
    );
    assertEquals(result, 0);
  });
});
