import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import type { ReviewWindowView } from "./db.ts";

function makeWindow(overrides: Partial<ReviewWindowView> = {}): ReviewWindowView {
  return {
    pr: {
      number: 1,
      title: "Test PR",
      url: "https://github.com/CruGlobal/repo/pull/1",
      author: "author",
    },
    repo: "mpdx-react",
    requestedAt: Temporal.Instant.from("2026-03-30T14:00:00Z"),
    respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
    respondedBy: "canac",
    requestedReviewers: ["canac"],
    businessHours: 1,
    ...overrides,
  };
}

describe("groupWaitingByReviewer", () => {
  it("groups open windows by each requested reviewer", () => {
    const windows = [
      makeWindow({
        respondedAt: null,
        respondedBy: null,
        requestedReviewers: ["canac", "dr-bizz"],
        businessHours: 5,
      }),
      makeWindow({
        pr: {
          number: 2,
          title: "PR 2",
          url: "https://github.com/CruGlobal/repo/pull/2",
          author: "author",
        },
        respondedAt: null,
        respondedBy: null,
        requestedReviewers: ["canac"],
        businessHours: 3,
      }),
    ];

    const grouped = groupWaitingByReviewer(windows);

    assertEquals(grouped.get("canac")!.length, 2);
    assertEquals(grouped.get("dr-bizz")!.length, 1);
    assertEquals(grouped.get("canac")![0].businessHours, 5);
    assertEquals(grouped.get("canac")![1].businessHours, 3);
  });

  it("skips closed windows", () => {
    const windows = [
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
      }),
    ];

    const grouped = groupWaitingByReviewer(windows);
    assertEquals(grouped.size, 0);
  });
});

describe("computeWeeklyTrend", () => {
  it("buckets closed windows by ISO week of response", () => {
    const windows = [
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-23T15:00:00Z"),
        businessHours: 2,
      }),
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-25T15:00:00Z"),
        businessHours: 4,
      }),
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
        businessHours: 6,
      }),
    ];

    const trend = computeWeeklyTrend(windows);

    assertEquals(trend.length, 2);
    assertEquals(trend[0].weekStart, "2026-03-23");
    assertEquals(trend[0].median, 3);
    assertEquals(trend[1].weekStart, "2026-03-30");
    assertEquals(trend[1].median, 6);
  });

  it("skips open windows", () => {
    const windows = [
      makeWindow({ respondedAt: null, respondedBy: null }),
    ];

    const trend = computeWeeklyTrend(windows);
    assertEquals(trend.length, 0);
  });
});

describe("computeReviewerDetails", () => {
  it("returns per-reviewer stats and individual windows sorted by hours descending", () => {
    const windows = [
      makeWindow({ respondedBy: "canac", businessHours: 2 }),
      makeWindow({ respondedBy: "canac", businessHours: 8 }),
      makeWindow({ respondedBy: "dr-bizz", businessHours: 5 }),
    ];

    const details = computeReviewerDetails(windows);

    assertEquals(details.length, 2);
    const canacDetail = details.find((detail) => detail.reviewer === "canac")!;
    assertEquals(canacDetail.stats.count, 2);
    assertEquals(canacDetail.windows[0].businessHours, 8);
    assertEquals(canacDetail.windows[1].businessHours, 2);
  });

  it("skips open windows", () => {
    const windows = [
      makeWindow({ respondedAt: null, respondedBy: null }),
    ];

    const details = computeReviewerDetails(windows);
    assertEquals(details.length, 0);
  });
});
