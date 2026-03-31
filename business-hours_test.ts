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
    // Monday 3pm ET → Tuesday 11am ET = 2h Monday (3pm→5pm) + 2h Tuesday (9am→11am) = 4h
    const result = businessHoursElapsed(
      instant("2026-03-30T19:00:00Z"), // Monday 3pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 4);
  });

  it("across a weekend", () => {
    // Friday 2pm ET → Monday 11am ET = 3h Friday (2pm→5pm) + 2h Monday (9am→11am) = 5h
    const result = businessHoursElapsed(
      instant("2026-03-27T18:00:00Z"), // Friday 2pm ET
      instant("2026-03-30T15:00:00Z"), // Monday 11am ET
    );
    assertEquals(result, 5);
  });

  it("start before business hours", () => {
    // Monday 8am ET → Monday 2pm ET = clamped to 9am, so 5h
    const result = businessHoursElapsed(
      instant("2026-03-30T12:00:00Z"), // 8am ET
      instant("2026-03-30T18:00:00Z"), // 2pm ET
    );
    assertEquals(result, 5);
  });

  it("start after business hours", () => {
    // Monday 6pm ET → Tuesday 11am ET = clamped to Tue 9am, so 2h
    const result = businessHoursElapsed(
      instant("2026-03-30T22:00:00Z"), // Monday 6pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 2);
  });

  it("start on weekend", () => {
    // Saturday 12pm ET → Monday 2pm ET = clamped to Mon 9am, so 5h
    const result = businessHoursElapsed(
      instant("2026-03-28T16:00:00Z"), // Saturday 12pm ET
      instant("2026-03-30T18:00:00Z"), // Monday 2pm ET
    );
    assertEquals(result, 5);
  });

  it("end after business hours clamps to close", () => {
    // Monday 10am ET → Monday 7pm ET = clamped to 5pm, so 7h
    const result = businessHoursElapsed(
      instant("2026-03-30T14:00:00Z"), // Monday 10am ET
      instant("2026-03-30T23:00:00Z"), // Monday 7pm ET
    );
    assertEquals(result, 7);
  });

  it("multi-day span", () => {
    // Monday 9am ET → Wednesday 5pm ET = 8 + 8 + 8 = 24h
    const result = businessHoursElapsed(
      instant("2026-03-30T13:00:00Z"), // Monday 9am ET
      instant("2026-04-01T21:00:00Z"), // Wednesday 5pm ET
    );
    assertEquals(result, 24);
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
