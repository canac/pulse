import type { DatabaseSync } from "node:sqlite";
import { TEAM_MEMBERS } from "./config.ts";
import type { TimelineItem } from "./github.ts";
import {
  addReviewRequestedReviewer,
  completeReview,
  getLastReviewForPR,
  insertReview,
} from "./db.ts";

const TEAM_MEMBER_SET = new Set<string>(TEAM_MEMBERS);

export function ingestTimelineEvents(
  database: DatabaseSync,
  repo: string,
  prNumber: number,
  prAuthor: string,
  events: TimelineItem[],
): void {
  for (const event of events) {
    const lastReview = getLastReviewForPR(database, repo, prNumber);
    const hasOpenWindow = lastReview !== null && lastReview.completed_at === null;

    if (event.__typename === "ReviewRequestedEvent") {
      const reviewerLogin = event.requestedReviewer?.login;
      if (!reviewerLogin || !TEAM_MEMBER_SET.has(reviewerLogin)) {
        continue;
      }

      if (hasOpenWindow) {
        addReviewRequestedReviewer(database, lastReview.id, reviewerLogin);
      } else {
        const reviewId = insertReview(database, {
          repo,
          prNumber,
          requestedAt: event.createdAt,
        });
        addReviewRequestedReviewer(database, reviewId, reviewerLogin);
      }
    } else if (
      event.__typename === "PullRequestReview" ||
      event.__typename === "IssueComment"
    ) {
      if (!hasOpenWindow) {
        continue;
      }

      const authorLogin = event.author?.login;
      if (!authorLogin || authorLogin === prAuthor || !TEAM_MEMBER_SET.has(authorLogin)) {
        continue;
      }

      completeReview(database, lastReview.id, event.createdAt, authorLogin);
    }
  }
}
