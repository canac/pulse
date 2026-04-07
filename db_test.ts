import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertNotEquals } from "@std/assert";
import { createClient, type Client } from "@libsql/client";
import {
  addReviewRequestedReviewer,
  completeReview,
  createSchema,
  getLastFetchedAt,
  getLastReviewForPR,
  getOpenPullRequests,
  getRepoCursor,
  insertReview,
  loadReviewWindows,
  setLastFetchedAt,
  setRepoCursor,
  updateTimelineCursor,
  upsertPullRequest,
} from "./db.ts";

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
    nodeId: string;
    title: string;
    url: string;
    author: string;
    state: string;
    isDraft: boolean;
    createdAt: string;
  }> = {},
): Promise<void> {
  await upsertPullRequest(client, {
    repo: overrides.repo ?? "org/repo",
    number: overrides.number ?? 1,
    nodeId: overrides.nodeId ?? "NODE_1",
    title: overrides.title ?? "Test PR",
    url: overrides.url ?? "https://github.com/org/repo/pull/1",
    author: overrides.author ?? "alice",
    state: overrides.state ?? "OPEN",
    isDraft: overrides.isDraft ?? false,
    createdAt: overrides.createdAt ?? "2026-04-01T12:00:00Z",
  });
}

describe("createSchema", () => {
  it("creates all 5 tables", async () => {
    const client = await createTestDb();
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tableNames = result.rows.map((row) => row.name as string);
    assertEquals(tableNames.includes("pull_requests"), true);
    assertEquals(tableNames.includes("reviews"), true);
    assertEquals(tableNames.includes("review_requested_reviewers"), true);
    assertEquals(tableNames.includes("repo_cursors"), true);
    assertEquals(tableNames.includes("metadata"), true);
  });

  it("is idempotent", async () => {
    const client = createClient({ url: ":memory:" });
    await createSchema(client);
    await createSchema(client);
    // No error means success
  });
});

describe("upsertPullRequest", () => {
  it("inserts a new pull request", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    const result = await client.execute("SELECT * FROM pull_requests");
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].repo, "org/repo");
    assertEquals(result.rows[0].number, 1);
    assertEquals(result.rows[0].title, "Test PR");
    assertEquals(result.rows[0].is_draft, 0);
  });

  it("updates mutable fields on conflict", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { title: "Original Title", state: "OPEN", isDraft: false });
    await insertTestPR(client, { title: "Updated Title", state: "CLOSED", isDraft: true });

    const result = await client.execute("SELECT * FROM pull_requests");
    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].title, "Updated Title");
    assertEquals(result.rows[0].state, "CLOSED");
    assertEquals(result.rows[0].is_draft, 1);
    // Immutable fields should not change
    assertEquals(result.rows[0].author, "alice");
    assertEquals(result.rows[0].node_id, "NODE_1");
  });

  it("stores isDraft as integer", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { isDraft: true });
    const result = await client.execute("SELECT is_draft FROM pull_requests");
    assertEquals(result.rows[0].is_draft, 1);
  });
});

describe("getOpenPullRequests", () => {
  it("returns only OPEN pull requests", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { number: 1, state: "OPEN" });
    await insertTestPR(client, { number: 2, state: "CLOSED" });
    await insertTestPR(client, { number: 3, state: "MERGED" });
    await insertTestPR(client, { number: 4, state: "OPEN" });

    const openPRs = await getOpenPullRequests(client);
    assertEquals(openPRs.length, 2);
    assertEquals(openPRs.map((pr) => pr.number as number).sort(), [1, 4]);
  });

  it("returns empty array when no open PRs", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { state: "CLOSED" });
    assertEquals((await getOpenPullRequests(client)).length, 0);
  });
});

describe("review CRUD", () => {
  it("inserts a review and returns lastInsertRowid", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    assertEquals(typeof reviewId, "number");
    assertEquals(reviewId > 0, true);
  });

  it("adds reviewers with INSERT OR IGNORE", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    await addReviewRequestedReviewer(client, reviewId, "bob");
    await addReviewRequestedReviewer(client, reviewId, "carol");
    // Duplicate should not throw
    await addReviewRequestedReviewer(client, reviewId, "bob");

    const result = await client.execute({
      sql: "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer",
      args: [reviewId],
    });
    assertEquals(result.rows.length, 2);
    assertEquals(result.rows[0].reviewer, "bob");
    assertEquals(result.rows[1].reviewer, "carol");
  });

  it("gets last review for a PR", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    const secondId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-02T13:00:00Z",
    });

    const lastReview = await getLastReviewForPR(client, "org/repo", 1);
    assertNotEquals(lastReview, null);
    assertEquals(lastReview!.id, secondId);
    assertEquals(lastReview!.requested_at, "2026-04-02T13:00:00Z");
  });

  it("returns null when no reviews exist", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    assertEquals(await getLastReviewForPR(client, "org/repo", 1), null);
  });

  it("completes a review", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    await completeReview(client, reviewId, "2026-04-01T15:00:00Z", "bob");

    const review = await getLastReviewForPR(client, "org/repo", 1);
    assertEquals(review!.completed_at, "2026-04-01T15:00:00Z");
    assertEquals(review!.responded_by, "bob");
  });
});

describe("cursor helpers", () => {
  it("returns null for unknown repo cursor", async () => {
    const client = await createTestDb();
    assertEquals(await getRepoCursor(client, "org/repo"), null);
  });

  it("sets and gets repo cursor", async () => {
    const client = await createTestDb();
    await setRepoCursor(client, "org/repo", "cursor_abc");
    assertEquals(await getRepoCursor(client, "org/repo"), "cursor_abc");
  });

  it("updates repo cursor on conflict", async () => {
    const client = await createTestDb();
    await setRepoCursor(client, "org/repo", "cursor_1");
    await setRepoCursor(client, "org/repo", "cursor_2");
    assertEquals(await getRepoCursor(client, "org/repo"), "cursor_2");
  });

  it("updates timeline cursor on a PR", async () => {
    const client = await createTestDb();
    await insertTestPR(client);
    await updateTimelineCursor(client, "org/repo", 1, "timeline_xyz");

    const result = await client.execute({
      sql: "SELECT timeline_cursor FROM pull_requests WHERE repo = ? AND number = ?",
      args: ["org/repo", 1],
    });
    assertEquals(result.rows[0].timeline_cursor, "timeline_xyz");
  });
});

describe("metadata helpers", () => {
  it("returns null when lastFetchedAt is not set", async () => {
    const client = await createTestDb();
    assertEquals(await getLastFetchedAt(client), null);
  });

  it("sets and gets lastFetchedAt", async () => {
    const client = await createTestDb();
    const date = new Date("2026-04-07T10:00:00Z");
    await setLastFetchedAt(client, date);
    const result = await getLastFetchedAt(client);
    assertEquals(result!.toISOString(), date.toISOString());
  });

  it("updates lastFetchedAt on conflict", async () => {
    const client = await createTestDb();
    await setLastFetchedAt(client, new Date("2026-04-06T10:00:00Z"));
    await setLastFetchedAt(client, new Date("2026-04-07T10:00:00Z"));
    const result = await getLastFetchedAt(client);
    assertEquals(result!.toISOString(), "2026-04-07T10:00:00.000Z");
  });
});

describe("loadReviewWindows", () => {
  it("returns closed review windows", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    await addReviewRequestedReviewer(client, reviewId, "bob");
    await completeReview(client, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = await loadReviewWindows(client, "2026-03-01T00:00:00Z");
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 1);
    assertEquals(windows[0].pr.title, "Test PR");
    assertEquals(windows[0].pr.author, "alice");
    assertEquals(windows[0].repo, "org/repo");
    assertEquals(windows[0].respondedBy, "bob");
    assertEquals(windows[0].requestedReviewers, ["bob"]);
    assertNotEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].businessHours >= 0, true);
  });

  it("includes open reviews only for OPEN PRs", async () => {
    const client = await createTestDb();
    // OPEN PR with open review — should be included
    await insertTestPR(client, { number: 1, state: "OPEN", createdAt: "2026-04-01T12:00:00Z" });
    await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });

    // CLOSED PR with open review — should be excluded
    await insertTestPR(client, { number: 2, state: "CLOSED", createdAt: "2026-04-01T12:00:00Z" });
    await insertReview(client, {
      repo: "org/repo",
      prNumber: 2,
      requestedAt: "2026-04-01T14:00:00Z",
    });

    const windows = await loadReviewWindows(client, "2026-03-01T00:00:00Z");
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 1);
  });

  it("filters by lookback date", async () => {
    const client = await createTestDb();
    // PR created before the lookback — should be excluded
    await insertTestPR(client, { number: 1, createdAt: "2026-01-01T12:00:00Z" });
    const reviewId1 = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-01-01T14:00:00Z",
    });
    await completeReview(client, reviewId1, "2026-01-01T16:00:00Z", "bob");

    // PR created after the lookback — should be included
    await insertTestPR(client, { number: 2, createdAt: "2026-04-01T12:00:00Z" });
    const reviewId2 = await insertReview(client, {
      repo: "org/repo",
      prNumber: 2,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    await completeReview(client, reviewId2, "2026-04-01T16:00:00Z", "carol");

    const windows = await loadReviewWindows(client, "2026-03-01T00:00:00Z");
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 2);
  });

  it("handles reviews with multiple reviewers", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    await addReviewRequestedReviewer(client, reviewId, "bob");
    await addReviewRequestedReviewer(client, reviewId, "carol");
    await completeReview(client, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = await loadReviewWindows(client, "2026-03-01T00:00:00Z");
    assertEquals(windows[0].requestedReviewers.sort(), ["bob", "carol"]);
  });

  it("returns empty requestedReviewers when none assigned", async () => {
    const client = await createTestDb();
    await insertTestPR(client, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = await insertReview(client, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    await completeReview(client, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = await loadReviewWindows(client, "2026-03-01T00:00:00Z");
    assertEquals(windows[0].requestedReviewers, []);
  });
});
