import type { Client } from "@libsql/client";
import { TEAM_MEMBERS } from "./config.ts";
import type { TimelineItem } from "./github.ts";
import {
  addReviewRequestedReviewer,
  completeReview,
  getLastReviewForPR,
  insertReview,
} from "./db.ts";

const TEAM_MEMBER_SET = new Set<string>(TEAM_MEMBERS);

export async function ingestTimelineEvents(
  client: Client,
  repo: string,
  prNumber: number,
  prAuthor: string,
  events: TimelineItem[],
): Promise<void> {
  for (const event of events) {
    const lastReview = await getLastReviewForPR(client, repo, prNumber);
    const hasOpenWindow = lastReview !== null && lastReview.completed_at === null;

    if (event.__typename === "ReviewRequestedEvent") {
      const reviewerLogin = event.requestedReviewer?.login;
      if (!reviewerLogin || !TEAM_MEMBER_SET.has(reviewerLogin)) {
        continue;
      }

      if (hasOpenWindow) {
        await addReviewRequestedReviewer(client, lastReview.id, reviewerLogin);
      } else {
        const reviewId = await insertReview(client, {
          repo,
          prNumber,
          requestedAt: event.createdAt,
        });
        await addReviewRequestedReviewer(client, reviewId, reviewerLogin);
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

      await completeReview(client, lastReview.id, event.createdAt, authorLogin);
    }
  }
}
