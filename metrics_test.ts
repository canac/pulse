import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { computeStats } from "./metrics.ts";

describe("computeStats", () => {
  it("array of 10 values has correct median (5.5), P75 (7), P90 (9), count (10)", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stats = computeStats(values);

    assertEquals(stats.count, 10);
    assertEquals(stats.median, 5.5);
    assertEquals(stats.p75, 7);
    assertEquals(stats.p90, 9);
  });

  it("single value has that value for median, P75, and P90", () => {
    const stats = computeStats([42]);

    assertEquals(stats.count, 1);
    assertEquals(stats.median, 42);
    assertEquals(stats.p75, 42);
    assertEquals(stats.p90, 42);
  });

  it("empty array returns all zeros", () => {
    const stats = computeStats([]);

    assertEquals(stats.median, 0);
    assertEquals(stats.p75, 0);
    assertEquals(stats.p90, 0);
    assertEquals(stats.count, 0);
  });
});
