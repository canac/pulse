import { computeStats, type Stats } from "./metrics.ts";
import { BUSINESS_HOURS } from "./config.ts";
import type { ReviewWindowView } from "./db.ts";

export function groupWaitingByReviewer(
  windows: ReviewWindowView[],
): Map<string, ReviewWindowView[]> {
  const byReviewer = new Map<string, ReviewWindowView[]>();

  for (const window of windows) {
    if (window.respondedAt !== null) {
      continue;
    }
    for (const reviewer of window.requestedReviewers) {
      const list = byReviewer.get(reviewer) ?? [];
      list.push(window);
      byReviewer.set(reviewer, list);
    }
  }

  for (const list of byReviewer.values()) {
    list.sort(
      (windowA, windowB) => windowB.businessHours - windowA.businessHours,
    );
  }

  return byReviewer;
}

export interface WeekBucket {
  weekStart: string;
  median: number;
}

export function computeWeeklyTrend(windows: ReviewWindowView[]): WeekBucket[] {
  const buckets = new Map<string, number[]>();

  for (const window of windows) {
    if (window.respondedAt === null) {
      continue;
    }
    const respondedDate = window.respondedAt
      .toZonedDateTimeISO(BUSINESS_HOURS.tz)
      .toPlainDate();
    const monday = respondedDate.subtract({
      days: respondedDate.dayOfWeek - 1,
    });
    const key = monday.toString();

    const hours = buckets.get(key) ?? [];
    hours.push(window.businessHours);
    buckets.set(key, hours);
  }

  return Array.from(buckets.entries())
    .sort(([weekA], [weekB]) => weekA.localeCompare(weekB))
    .map(([weekStart, hours]) => ({
      weekStart,
      median: computeStats(hours).median,
    }));
}

export interface ReviewerDetail {
  reviewer: string;
  stats: Stats;
  windows: ReviewWindowView[];
}

export function computeReviewerDetails(
  windows: ReviewWindowView[],
): ReviewerDetail[] {
  const byReviewer = new Map<string, ReviewWindowView[]>();

  for (const window of windows) {
    if (window.respondedAt === null || !window.respondedBy) {
      continue;
    }
    const list = byReviewer.get(window.respondedBy) ?? [];
    list.push(window);
    byReviewer.set(window.respondedBy, list);
  }

  return Array.from(byReviewer.entries())
    .map(([reviewer, reviewerWindows]) => ({
      reviewer,
      stats: computeStats(
        reviewerWindows.map((window) => window.businessHours),
      ),
      windows: reviewerWindows.toSorted(
        (windowA, windowB) => windowB.businessHours - windowA.businessHours,
      ),
    }))
    .sort(
      (detailA, detailB) => detailB.stats.median - detailA.stats.median,
    );
}
