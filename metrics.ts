import { TEAM_MEMBERS } from "./config.ts";
import { businessHoursElapsed } from "./business-hours.ts";
import type { PullRequest } from "./github.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewWindow {
  pr: { number: number; title: string; url: string; author: string };
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  businessHours: number;
}

export interface Stats {
  median: number;
  p90: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_MEMBER_SET = new Set<string>(TEAM_MEMBERS);

function isTeamMember(login: string): boolean {
  return TEAM_MEMBER_SET.has(login);
}

// ---------------------------------------------------------------------------
// extractReviewWindows
// ---------------------------------------------------------------------------

export function* extractReviewWindows(
  prs: Iterable<PullRequest>,
): Generator<ReviewWindow> {
  for (const pullRequest of prs) {
    const prAuthor = pullRequest.author?.login ?? "";
    const prInfo = {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      author: prAuthor,
    };

    // Sort timeline items by createdAt ascending
    const sortedItems = [...pullRequest.timelineItems.nodes].sort((itemA, itemB) => {
      const instantA = Temporal.Instant.from(itemA.createdAt);
      const instantB = Temporal.Instant.from(itemB.createdAt);
      return Temporal.Instant.compare(instantA, instantB);
    });

    let openWindowStart: Temporal.Instant | null = null;

    for (const item of sortedItems) {
      if (item.__typename === "ReviewRequestedEvent") {
        // Only count review requests directed at a team member
        const requestedLogin = item.requestedReviewer?.login;
        if (!requestedLogin || !isTeamMember(requestedLogin)) {
          continue;
        }
        // Only open a new window if none is currently open (de-duplicate)
        if (openWindowStart === null) {
          openWindowStart = Temporal.Instant.from(item.createdAt);
        }
        continue;
      }

      if (
        item.__typename === "PullRequestReview" ||
        item.__typename === "IssueComment"
      ) {
        // Ignore if no window is open
        if (openWindowStart === null) {
          continue;
        }

        const responderLogin = item.author?.login ?? "";

        // Ignore responses from the PR author or non-team members
        if (responderLogin === prAuthor || !isTeamMember(responderLogin)) {
          continue;
        }

        // Close the window and yield it
        const respondedAt = Temporal.Instant.from(item.createdAt);
        yield {
          pr: prInfo,
          requestedAt: openWindowStart,
          respondedAt,
          respondedBy: responderLogin,
          businessHours: businessHoursElapsed(openWindowStart, respondedAt),
        };

        openWindowStart = null;
      }
    }

    // If window still open after processing all items, yield it as pending
    if (openWindowStart !== null) {
      const nowInstant = Temporal.Now.instant();
      yield {
        pr: prInfo,
        requestedAt: openWindowStart,
        respondedAt: null,
        respondedBy: null,
        businessHours: businessHoursElapsed(openWindowStart, nowInstant),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { median: 0, p90: 0, count: 0 };
  }

  const sorted = [...values].sort((numA, numB) => numA - numB);
  const count = sorted.length;

  // Compute median
  const midIndex = Math.floor(count / 2);
  const median = count % 2 === 1
    ? sorted[midIndex]
    : (sorted[midIndex - 1] + sorted[midIndex]) / 2;

  // Compute P90 (nearest-rank method: 90th percentile index in 0-based sorted array)
  const p90Index = Math.floor((count - 1) * 0.9);
  const p90 = sorted[p90Index];

  return { median, p90, count };
}
