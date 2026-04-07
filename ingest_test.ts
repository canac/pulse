import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { type Client, createClient } from "@libsql/client";
import { createSchema, getLastReviewForPR, upsertPullRequest } from "./db.ts";
import { ingestTimelineEvents } from "./ingest.ts";
import type { TimelineItem } from "./github.ts";

async function createTestDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await createSchema(client);
  return client;
}

async function insertTestPR(
  client: Client,
  overrides: Partial<{
    repo: string;
    number: number;
    author: string;
  }> = {},
): Promise<void> {
  await upsertPullRequest(client, {
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

async function getReviewers(
  client: Client,
  reviewId: number,
): Promise<string[]> {
  const result = await client.execute({
    sql:
      "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer",
    args: [reviewId],
  });
  return result.rows.map((row) => row.reviewer as string);
}

async function getAllReviews(client: Client, repo: string, prNumber: number) {
  const result = await client.execute({
    sql: "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY id",
    args: [repo, prNumber],
  });
  return result.rows as unknown as Array<{
    id: number;
    repo: string;
    pr_number: number;
    requested_at: string;
    completed_at: string | null;
    responded_by: string | null;
  }>;
}

describe("ingestTimelineEvents", () => {
  it("request + review creates one completed review", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(reviews[0].requested_at, "2026-04-01T13:00:00Z");
    assertEquals(reviews[0].completed_at, "2026-04-01T14:00:00Z");
    assertEquals(reviews[0].responded_by, "dr-bizz");
    assertEquals(await getReviewers(client, reviews[0].id), ["dr-bizz"]);
  });

  it("review requests to non-team members are ignored", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "external-user" },
      },
    ];

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 0);
  });

  it("duplicate review requests when window is open — one review, both reviewers tracked", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(await getReviewers(client, reviews[0].id), [
      "dr-bizz",
      "kegrimes",
    ]);
  });

  it("reviews from PR author are ignored", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { author: "canac" });

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const lastReview = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(lastReview!.completed_at, null);
  });

  it("reviews from non-team members are ignored", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const lastReview = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(lastReview!.completed_at, null);
  });

  it("IssueComment from team member closes window", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const lastReview = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(lastReview!.completed_at, "2026-04-01T14:30:00Z");
    assertEquals(lastReview!.responded_by, "kegrimes");
  });

  it("two review cycles produce two review rows", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 2);
    assertEquals(reviews[0].completed_at, "2026-04-01T14:00:00Z");
    assertEquals(reviews[0].responded_by, "dr-bizz");
    assertEquals(reviews[1].completed_at, "2026-04-01T16:00:00Z");
    assertEquals(reviews[1].responded_by, "kegrimes");
  });

  it("reviews/comments with no open window are ignored", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

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

    await ingestTimelineEvents(client, "org/repo", 1, "canac", events);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 0);
  });

  it("incremental: first call opens window, second call closes it", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

    await ingestTimelineEvents(client, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
    ]);

    const afterFirstCall = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(afterFirstCall!.completed_at, null);

    await ingestTimelineEvents(client, "org/repo", 1, "canac", [
      {
        __typename: "PullRequestReview",
        createdAt: "2026-04-01T14:00:00Z",
        author: { login: "dr-bizz" },
      },
    ]);

    const afterSecondCall = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(afterSecondCall!.completed_at, "2026-04-01T14:00:00Z");
    assertEquals(afterSecondCall!.responded_by, "dr-bizz");
  });

  it("incremental: open window exists, new review request adds reviewer to existing window", async () => {
    const client = await createTestDb();
    await insertTestPR(client);

    await ingestTimelineEvents(client, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:00:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
    ]);

    const afterFirstCall = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(await getReviewers(client, afterFirstCall!.id), ["dr-bizz"]);

    await ingestTimelineEvents(client, "org/repo", 1, "canac", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-04-01T13:05:00Z",
        requestedReviewer: { login: "kegrimes" },
      },
    ]);

    const reviews = await getAllReviews(client, "org/repo", 1);
    assertEquals(reviews.length, 1);
    assertEquals(await getReviewers(client, reviews[0].id), [
      "dr-bizz",
      "kegrimes",
    ]);
  });
});
