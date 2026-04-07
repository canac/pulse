import { describe, it } from "@std/testing/bdd";
import { assertEquals, assertNotEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
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
    nodeId: string;
    title: string;
    url: string;
    author: string;
    state: string;
    isDraft: boolean;
    createdAt: string;
  }> = {},
): void {
  upsertPullRequest(database, {
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
  it("creates all 5 tables", () => {
    const database = createTestDb();
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name);
    assertEquals(tableNames.includes("pull_requests"), true);
    assertEquals(tableNames.includes("reviews"), true);
    assertEquals(tableNames.includes("review_requested_reviewers"), true);
    assertEquals(tableNames.includes("repo_cursors"), true);
    assertEquals(tableNames.includes("metadata"), true);
  });

  it("is idempotent", () => {
    const database = new DatabaseSync(":memory:");
    createSchema(database);
    createSchema(database);
    // No error means success
  });
});

describe("upsertPullRequest", () => {
  it("inserts a new pull request", () => {
    const database = createTestDb();
    insertTestPR(database);
    const rows = database.prepare("SELECT * FROM pull_requests").all() as Array<
      Record<string, unknown>
    >;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].repo, "org/repo");
    assertEquals(rows[0].number, 1);
    assertEquals(rows[0].title, "Test PR");
    assertEquals(rows[0].is_draft, 0);
  });

  it("updates mutable fields on conflict", () => {
    const database = createTestDb();
    insertTestPR(database, { title: "Original Title", state: "OPEN", isDraft: false });
    insertTestPR(database, { title: "Updated Title", state: "CLOSED", isDraft: true });

    const rows = database.prepare("SELECT * FROM pull_requests").all() as Array<
      Record<string, unknown>
    >;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].title, "Updated Title");
    assertEquals(rows[0].state, "CLOSED");
    assertEquals(rows[0].is_draft, 1);
    // Immutable fields should not change
    assertEquals(rows[0].author, "alice");
    assertEquals(rows[0].node_id, "NODE_1");
  });

  it("stores isDraft as integer", () => {
    const database = createTestDb();
    insertTestPR(database, { isDraft: true });
    const row = database.prepare("SELECT is_draft FROM pull_requests").get() as {
      is_draft: number;
    };
    assertEquals(row.is_draft, 1);
  });
});

describe("getOpenPullRequests", () => {
  it("returns only OPEN pull requests", () => {
    const database = createTestDb();
    insertTestPR(database, { number: 1, state: "OPEN" });
    insertTestPR(database, { number: 2, state: "CLOSED" });
    insertTestPR(database, { number: 3, state: "MERGED" });
    insertTestPR(database, { number: 4, state: "OPEN" });

    const openPRs = getOpenPullRequests(database);
    assertEquals(openPRs.length, 2);
    assertEquals(openPRs.map((pr) => pr.number).sort(), [1, 4]);
  });

  it("returns empty array when no open PRs", () => {
    const database = createTestDb();
    insertTestPR(database, { state: "CLOSED" });
    assertEquals(getOpenPullRequests(database).length, 0);
  });
});

describe("review CRUD", () => {
  it("inserts a review and returns lastInsertRowid", () => {
    const database = createTestDb();
    insertTestPR(database);
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    assertEquals(typeof reviewId, "number");
    assertEquals(reviewId > 0, true);
  });

  it("adds reviewers with INSERT OR IGNORE", () => {
    const database = createTestDb();
    insertTestPR(database);
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId, "bob");
    addReviewRequestedReviewer(database, reviewId, "carol");
    // Duplicate should not throw
    addReviewRequestedReviewer(database, reviewId, "bob");

    const reviewers = database.prepare(
      "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer",
    ).all(reviewId) as Array<{ reviewer: string }>;
    assertEquals(reviewers.length, 2);
    assertEquals(reviewers[0].reviewer, "bob");
    assertEquals(reviewers[1].reviewer, "carol");
  });

  it("gets last review for a PR", () => {
    const database = createTestDb();
    insertTestPR(database);
    insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    const secondId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-02T13:00:00Z",
    });

    const lastReview = getLastReviewForPR(database, "org/repo", 1);
    assertNotEquals(lastReview, null);
    assertEquals(lastReview!.id, secondId);
    assertEquals(lastReview!.requested_at, "2026-04-02T13:00:00Z");
  });

  it("returns null when no reviews exist", () => {
    const database = createTestDb();
    insertTestPR(database);
    assertEquals(getLastReviewForPR(database, "org/repo", 1), null);
  });

  it("completes a review", () => {
    const database = createTestDb();
    insertTestPR(database);
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T13:00:00Z",
    });
    completeReview(database, reviewId, "2026-04-01T15:00:00Z", "bob");

    const review = getLastReviewForPR(database, "org/repo", 1);
    assertEquals(review!.completed_at, "2026-04-01T15:00:00Z");
    assertEquals(review!.responded_by, "bob");
  });
});

describe("cursor helpers", () => {
  it("returns null for unknown repo cursor", () => {
    const database = createTestDb();
    assertEquals(getRepoCursor(database, "org/repo"), null);
  });

  it("sets and gets repo cursor", () => {
    const database = createTestDb();
    setRepoCursor(database, "org/repo", "cursor_abc");
    assertEquals(getRepoCursor(database, "org/repo"), "cursor_abc");
  });

  it("updates repo cursor on conflict", () => {
    const database = createTestDb();
    setRepoCursor(database, "org/repo", "cursor_1");
    setRepoCursor(database, "org/repo", "cursor_2");
    assertEquals(getRepoCursor(database, "org/repo"), "cursor_2");
  });

  it("updates timeline cursor on a PR", () => {
    const database = createTestDb();
    insertTestPR(database);
    updateTimelineCursor(database, "org/repo", 1, "timeline_xyz");

    const row = database.prepare(
      "SELECT timeline_cursor FROM pull_requests WHERE repo = ? AND number = ?",
    ).get("org/repo", 1) as { timeline_cursor: string };
    assertEquals(row.timeline_cursor, "timeline_xyz");
  });
});

describe("metadata helpers", () => {
  it("returns null when lastFetchedAt is not set", () => {
    const database = createTestDb();
    assertEquals(getLastFetchedAt(database), null);
  });

  it("sets and gets lastFetchedAt", () => {
    const database = createTestDb();
    const date = new Date("2026-04-07T10:00:00Z");
    setLastFetchedAt(database, date);
    const result = getLastFetchedAt(database);
    assertEquals(result!.toISOString(), date.toISOString());
  });

  it("updates lastFetchedAt on conflict", () => {
    const database = createTestDb();
    setLastFetchedAt(database, new Date("2026-04-06T10:00:00Z"));
    setLastFetchedAt(database, new Date("2026-04-07T10:00:00Z"));
    const result = getLastFetchedAt(database);
    assertEquals(result!.toISOString(), "2026-04-07T10:00:00.000Z");
  });
});

describe("loadReviewWindows", () => {
  it("returns closed review windows", () => {
    const database = createTestDb();
    insertTestPR(database, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId, "bob");
    completeReview(database, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");
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

  it("includes open reviews only for OPEN PRs", () => {
    const database = createTestDb();
    // OPEN PR with open review — should be included
    insertTestPR(database, { number: 1, state: "OPEN", createdAt: "2026-04-01T12:00:00Z" });
    insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });

    // CLOSED PR with open review — should be excluded
    insertTestPR(database, { number: 2, state: "CLOSED", createdAt: "2026-04-01T12:00:00Z" });
    insertReview(database, {
      repo: "org/repo",
      prNumber: 2,
      requestedAt: "2026-04-01T14:00:00Z",
    });

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 1);
  });

  it("filters by lookback date", () => {
    const database = createTestDb();
    // PR created before the lookback — should be excluded
    insertTestPR(database, { number: 1, createdAt: "2026-01-01T12:00:00Z" });
    const reviewId1 = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-01-01T14:00:00Z",
    });
    completeReview(database, reviewId1, "2026-01-01T16:00:00Z", "bob");

    // PR created after the lookback — should be included
    insertTestPR(database, { number: 2, createdAt: "2026-04-01T12:00:00Z" });
    const reviewId2 = insertReview(database, {
      repo: "org/repo",
      prNumber: 2,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    completeReview(database, reviewId2, "2026-04-01T16:00:00Z", "carol");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 2);
  });

  it("handles reviews with multiple reviewers", () => {
    const database = createTestDb();
    insertTestPR(database, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId, "bob");
    addReviewRequestedReviewer(database, reviewId, "carol");
    completeReview(database, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");
    assertEquals(windows[0].requestedReviewers.sort(), ["bob", "carol"]);
  });

  it("returns empty requestedReviewers when none assigned", () => {
    const database = createTestDb();
    insertTestPR(database, { createdAt: "2026-04-01T12:00:00Z" });
    const reviewId = insertReview(database, {
      repo: "org/repo",
      prNumber: 1,
      requestedAt: "2026-04-01T14:00:00Z",
    });
    completeReview(database, reviewId, "2026-04-01T16:00:00Z", "bob");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");
    assertEquals(windows[0].requestedReviewers, []);
  });
});
