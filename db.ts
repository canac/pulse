import { DatabaseSync } from "node:sqlite";
import { businessHoursElapsed } from "./business-hours.ts";

// ── Types ──

export interface PullRequestRow {
  repo: string;
  number: number;
  node_id: string;
  title: string;
  url: string;
  author: string;
  state: string;
  is_draft: number;
  created_at: string;
  timeline_cursor: string | null;
}

export interface ReviewRow {
  id: number;
  repo: string;
  pr_number: number;
  requested_at: string;
  completed_at: string | null;
  responded_by: string | null;
}

export interface UpsertPullRequestInput {
  repo: string;
  number: number;
  nodeId: string;
  title: string;
  url: string;
  author: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
}

export interface InsertReviewInput {
  repo: string;
  prNumber: number;
  requestedAt: string;
}

export interface ReviewWindowView {
  pr: { number: number; title: string; url: string; author: string };
  repo: string;
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  requestedReviewers: string[];
  businessHours: number;
}

// ── Schema ──

export function createSchema(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");

  database.exec(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      author TEXT NOT NULL,
      state TEXT NOT NULL,
      is_draft INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      timeline_cursor TEXT,
      PRIMARY KEY (repo, number)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      responded_by TEXT,
      FOREIGN KEY (repo, pr_number) REFERENCES pull_requests(repo, number)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS review_requested_reviewers (
      review_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      PRIMARY KEY (review_id, reviewer),
      FOREIGN KEY (review_id) REFERENCES reviews(id)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS repo_cursors (
      repo TEXT PRIMARY KEY,
      prs_cursor TEXT NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// ── Singleton ──

let singletonDb: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!singletonDb) {
    singletonDb = new DatabaseSync("pulse.db");
    createSchema(singletonDb);
  }
  return singletonDb;
}

// ── Pull Requests ──

export function upsertPullRequest(
  database: DatabaseSync,
  input: UpsertPullRequestInput,
): void {
  database.prepare(`
    INSERT INTO pull_requests (repo, number, node_id, title, url, author, state, is_draft, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET
      title = excluded.title,
      state = excluded.state,
      is_draft = excluded.is_draft
  `).run(
    input.repo,
    input.number,
    input.nodeId,
    input.title,
    input.url,
    input.author,
    input.state,
    input.isDraft ? 1 : 0,
    input.createdAt,
  );
}

export function getOpenPullRequests(
  database: DatabaseSync,
): PullRequestRow[] {
  return database.prepare(
    "SELECT * FROM pull_requests WHERE state = 'OPEN'",
  ).all() as unknown as PullRequestRow[];
}

// ── Reviews ──

export function insertReview(
  database: DatabaseSync,
  input: InsertReviewInput,
): number {
  const result = database.prepare(`
    INSERT INTO reviews (repo, pr_number, requested_at)
    VALUES (?, ?, ?)
  `).run(input.repo, input.prNumber, input.requestedAt);
  return Number(result.lastInsertRowid);
}

export function addReviewRequestedReviewer(
  database: DatabaseSync,
  reviewId: number,
  reviewer: string,
): void {
  database.prepare(`
    INSERT OR IGNORE INTO review_requested_reviewers (review_id, reviewer)
    VALUES (?, ?)
  `).run(reviewId, reviewer);
}

export function getLastReviewForPR(
  database: DatabaseSync,
  repo: string,
  prNumber: number,
): ReviewRow | null {
  const row = database.prepare(`
    SELECT * FROM reviews
    WHERE repo = ? AND pr_number = ?
    ORDER BY id DESC LIMIT 1
  `).get(repo, prNumber) as ReviewRow | undefined;
  return row ?? null;
}

export function completeReview(
  database: DatabaseSync,
  reviewId: number,
  completedAt: string,
  respondedBy: string,
): void {
  database.prepare(`
    UPDATE reviews SET completed_at = ?, responded_by = ? WHERE id = ?
  `).run(completedAt, respondedBy, reviewId);
}

// ── Cursors ──

export function getRepoCursor(
  database: DatabaseSync,
  repo: string,
): string | null {
  const row = database.prepare(
    "SELECT prs_cursor FROM repo_cursors WHERE repo = ?",
  ).get(repo) as { prs_cursor: string } | undefined;
  return row?.prs_cursor ?? null;
}

export function setRepoCursor(
  database: DatabaseSync,
  repo: string,
  cursor: string,
): void {
  database.prepare(`
    INSERT INTO repo_cursors (repo, prs_cursor) VALUES (?, ?)
    ON CONFLICT (repo) DO UPDATE SET prs_cursor = excluded.prs_cursor
  `).run(repo, cursor);
}

export function updateTimelineCursor(
  database: DatabaseSync,
  repo: string,
  prNumber: number,
  cursor: string,
): void {
  database.prepare(`
    UPDATE pull_requests SET timeline_cursor = ? WHERE repo = ? AND number = ?
  `).run(cursor, repo, prNumber);
}

// ── Metadata ──

export function getLastFetchedAt(database: DatabaseSync): Date | null {
  const row = database.prepare(
    "SELECT value FROM metadata WHERE key = 'last_fetched_at'",
  ).get() as { value: string } | undefined;
  return row ? new Date(row.value) : null;
}

export function setLastFetchedAt(database: DatabaseSync, date: Date): void {
  database.prepare(`
    INSERT INTO metadata (key, value) VALUES ('last_fetched_at', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(date.toISOString());
}

// ── Review Windows ──

export function loadReviewWindows(
  database: DatabaseSync,
  sinceIso: string,
): ReviewWindowView[] {
  const rows = database.prepare(`
    SELECT r.id, r.repo, r.pr_number, r.requested_at, r.completed_at, r.responded_by,
           p.title, p.url, p.author, p.number, p.state,
           GROUP_CONCAT(rr.reviewer) AS reviewers
    FROM reviews r
    JOIN pull_requests p ON r.repo = p.repo AND r.pr_number = p.number
    LEFT JOIN review_requested_reviewers rr ON r.id = rr.review_id
    WHERE p.created_at >= ?
      AND (r.completed_at IS NOT NULL OR p.state = 'OPEN')
    GROUP BY r.id
  `).all(sinceIso) as Array<{
    id: number;
    repo: string;
    pr_number: number;
    requested_at: string;
    completed_at: string | null;
    responded_by: string | null;
    title: string;
    url: string;
    author: string;
    number: number;
    state: string;
    reviewers: string | null;
  }>;

  return rows.map((row) => {
    const requestedAt = Temporal.Instant.from(row.requested_at);
    const respondedAt = row.completed_at
      ? Temporal.Instant.from(row.completed_at)
      : null;
    const endInstant = respondedAt ?? Temporal.Now.instant();

    return {
      pr: {
        number: row.number,
        title: row.title,
        url: row.url,
        author: row.author,
      },
      repo: row.repo,
      requestedAt,
      respondedAt,
      respondedBy: row.responded_by,
      requestedReviewers: row.reviewers ? row.reviewers.split(",") : [],
      businessHours: businessHoursElapsed(requestedAt, endInstant),
    };
  });
}
