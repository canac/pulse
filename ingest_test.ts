import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createSchema, getLastReviewForPR, upsertPullRequest } from "./db.ts";
import { ingestTimelineEvents } from "./ingest.ts";
import type { TimelineItem } from "./github.ts";

function createTestDb(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  createSchema(database);
  return database;
}

function insertTestPR(
  database: DatabaseSync,
  overrides: Partial<{
    repo: string;
    number: number;
    author: string;
  }> = {},
): void {
  upsertPullRequest(database, {
    repo: overrides.repo ?? "org/repo",
    number: overrides.number ?? 1,
    nodeId: "NODE_1",
    title: "Test PR",
    url: "https://github.com/org/repo/pull/1",
    author: overrides.author ?? "canac",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-04-01T12:00:00Z",
  });
}

function getReviewers(database: DatabaseSync, reviewId: number): string[] {
  const rows = database.prepare(
    "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer",
  ).all(reviewId) as Array<{ reviewer: string }>;
  return rows.map((row) => row.reviewer);
}

function getAllReviews(database: DatabaseSync, repo: string, prNumber: number) {
  return database.prepare(
    "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY id",
  ).all(repo, prNumber) as Array<{
    id: number;
    repo: string;
    pr_number: number;
    requested_at: string;
    completed_at: string | null;
    responded_by: string | null;
  }>;
}

describe("ingestTimelineEvents", () => {
  it("request + review creates one completed review", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "dr-bizz" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(reviews[0].requested_at, "2026-04-01T13:00:00Z");
    assertEquals(reviews[0].completed_at, "2026-04-01T14:00:00Z");
    assertEquals(reviews[0].responded_by, "dr-bizz");
    assertEquals(getReviewers(database, reviews[0].id), ["dr-bizz"]);
  });

  it("review requests to non-team members are ignored", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "external-user" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 0);
  });

  it("duplicate review requests when window is open — one review, both reviewers tracked", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:05:00Z",
        requestedReviewer: { login: "kegrimes" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(getReviewers(database, reviews[0].id), ["dr-bizz", "kegrimes"]);
  });

  it("reviews from PR author are ignored", () => {
    const database = createTestDb();
    insertTestPR(database, { author: "canac" });

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "canac" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const lastReview = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(lastReview!.completed_at, null);
  });

  it("reviews from non-team members are ignored", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "external-user" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const lastReview = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(lastReview!.completed_at, null);
  });

  it("IssueComment from team member closes window", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "IssueComment",
        createdAt: "2026-04-01T14:30:00Z",
        author: { login: "kegrimes" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const lastReview = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(lastReview!.completed_at, "2026-04-01T14:30:00Z");
    assertEquals(lastReview!.responded_by, "kegrimes");
  });

  it("two review cycles produce two review rows", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "dr-bizz" },
      },
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T15:00:00Z",
        requestedReviewer: { login: "kegrimes" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T16:00:00Z",
        author: { login: "kegrimes" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 2);
    assertEquals(reviews[0].completed_at, "2026-04-01T14:00:00Z");
    assertEquals(reviews[0].responded_by, "dr-bizz");
    assertEquals(reviews[1].completed_at, "2026-04-01T16:00:00Z");
    assertEquals(reviews[1].responded_by, "kegrimes");
  });

  it("reviews/comments with no open window are ignored", () => {
    const database = createTestDb();
    insertTestPR(database);

    const events: TimelineItem[] = [
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "dr-bizz" },
      },
      {
        __typename: "IssueComment",
        createdAt: "2026-04-01T15:00:00Z",
        author: { login: "kegrimes" },
      },
    ];

    ingestTimelineEvents(database, "org/repo", 1, "canac", events);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 0);
  });

  it("incremental: first call opens window, second call closes it", () => {
    const database = createTestDb();
    insertTestPR(database);

    ingestTimelineEvents(database, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
    ]);

    const afterFirstCall = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(afterFirstCall!.completed_at, null);

    ingestTimelineEvents(database, "org/repo", 1, "canac", [
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "dr-bizz" },
      },
    ]);

    const afterSecondCall = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(afterSecondCall!.completed_at, "2026-04-01T14:00:00Z");
    assertEquals(afterSecondCall!.responded_by, "dr-bizz");
  });

  it("incremental: open window exists, new review request adds reviewer to existing window", () => {
    const database = createTestDb();
    insertTestPR(database);

    ingestTimelineEvents(database, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
    ]);

    const afterFirstCall = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(getReviewers(database, afterFirstCall!.id), ["dr-bizz"]);

    ingestTimelineEvents(database, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:05:00Z",
        requestedReviewer: { login: "kegrimes" },
      },
    ]);

    const reviews = getAllReviews(database, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(getReviewers(database, reviews[0].id), ["dr-bizz", "kegrimes"]);
  });
});
