import { createClient, type Client } from "@libsql/client";
import { businessHoursElapsed } from "./business-hours.ts";

export type { Client };

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

export async function createSchema(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");

  await client.batch([
    `CREATE TABLE IF NOT EXISTS pull_requests (
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
    )`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      responded_by TEXT,
      FOREIGN KEY (repo, pr_number) REFERENCES pull_requests(repo, number)
    )`,
    `CREATE TABLE IF NOT EXISTS review_requested_reviewers (
      review_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      PRIMARY KEY (review_id, reviewer),
      FOREIGN KEY (review_id) REFERENCES reviews(id)
    )`,
    `CREATE TABLE IF NOT EXISTS repo_cursors (
      repo TEXT PRIMARY KEY,
      prs_cursor TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ]);
}

// ── Singleton ──

let singletonClient: Client | null = null;

export function getDb(): Client {
  if (!singletonClient) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return singletonClient;
}

export async function initDb(): Promise<void> {
  if (!singletonClient) {
    const url = Deno.env.get("TURSO_URL");
    const authToken = Deno.env.get("TURSO_AUTH_TOKEN");
    if (!url) {
      throw new Error("TURSO_URL must be set in environment or .env file");
    }
    singletonClient = createClient({ url, authToken });
    await createSchema(singletonClient);
  }
}

// ── Pull Requests ──

export async function upsertPullRequest(
  client: Client,
  input: UpsertPullRequestInput,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO pull_requests (repo, number, node_id, title, url, author, state, is_draft, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo, number) DO UPDATE SET
      title = excluded.title,
      state = excluded.state,
      is_draft = excluded.is_draft`,
    args: [
      input.repo,
      input.number,
      input.nodeId,
      input.title,
      input.url,
      input.author,
      input.state,
      input.isDraft ? 1 : 0,
      input.createdAt,
    ],
  });
}

export async function getOpenPullRequests(
  client: Client,
): Promise<PullRequestRow[]> {
  const result = await client.execute(
    "SELECT * FROM pull_requests WHERE state = 'OPEN'",
  );
  return result.rows as unknown as PullRequestRow[];
}

// ── Reviews ──

export async function insertReview(
  client: Client,
  input: InsertReviewInput,
): Promise<number> {
  const result = await client.execute({
    sql: "INSERT INTO reviews (repo, pr_number, requested_at) VALUES (?, ?, ?)",
    args: [input.repo, input.prNumber, input.requestedAt],
  });
  return Number(result.lastInsertRowid);
}

export async function addReviewRequestedReviewer(
  client: Client,
  reviewId: number,
  reviewer: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT OR IGNORE INTO review_requested_reviewers (review_id, reviewer)
    VALUES (?, ?)`,
    args: [reviewId, reviewer],
  });
}

export async function getLastReviewForPR(
  client: Client,
  repo: string,
  prNumber: number,
): Promise<ReviewRow | null> {
  const result = await client.execute({
    sql: `SELECT * FROM reviews
    WHERE repo = ? AND pr_number = ?
    ORDER BY id DESC LIMIT 1`,
    args: [repo, prNumber],
  });
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0] as unknown as ReviewRow;
}

export async function completeReview(
  client: Client,
  reviewId: number,
  completedAt: string,
  respondedBy: string,
): Promise<void> {
  await client.execute({
    sql: "UPDATE reviews SET completed_at = ?, responded_by = ? WHERE id = ?",
    args: [completedAt, respondedBy, reviewId],
  });
}

// ── Cursors ──

export async function getRepoCursor(
  client: Client,
  repo: string,
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT prs_cursor FROM repo_cursors WHERE repo = ?",
    args: [repo],
  });
  if (result.rows.length === 0) {
    return null;
  }
  return result.rows[0].prs_cursor as string;
}

export async function getAllRepoCursors(
  client: Client,
): Promise<Map<string, string>> {
  const result = await client.execute(
    "SELECT repo, prs_cursor FROM repo_cursors",
  );
  return new Map(
    result.rows.map((row) => [row.repo as string, row.prs_cursor as string]),
  );
}

export async function setRepoCursor(
  client: Client,
  repo: string,
  cursor: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO repo_cursors (repo, prs_cursor) VALUES (?, ?)
    ON CONFLICT (repo) DO UPDATE SET prs_cursor = excluded.prs_cursor`,
    args: [repo, cursor],
  });
}

export async function updateTimelineCursor(
  client: Client,
  repo: string,
  prNumber: number,
  cursor: string,
): Promise<void> {
  await client.execute({
    sql: "UPDATE pull_requests SET timeline_cursor = ? WHERE repo = ? AND number = ?",
    args: [cursor, repo, prNumber],
  });
}

// ── Metadata ──

export async function getLastFetchedAt(client: Client): Promise<Date | null> {
  const result = await client.execute(
    "SELECT value FROM metadata WHERE key = 'last_fetched_at'",
  );
  if (result.rows.length === 0) {
    return null;
  }
  return new Date(result.rows[0].value as string);
}

export async function setLastFetchedAt(
  client: Client,
  date: Date,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO metadata (key, value) VALUES ('last_fetched_at', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    args: [date.toISOString()],
  });
}

// ── Review Windows ──

export async function loadReviewWindows(
  client: Client,
  sinceIso: string,
): Promise<ReviewWindowView[]> {
  const result = await client.execute({
    sql: `SELECT r.id, r.repo, r.pr_number, r.requested_at, r.completed_at, r.responded_by,
           p.title, p.url, p.author, p.number, p.state,
           GROUP_CONCAT(rr.reviewer) AS reviewers
    FROM reviews r
    JOIN pull_requests p ON r.repo = p.repo AND r.pr_number = p.number
    LEFT JOIN review_requested_reviewers rr ON r.id = rr.review_id
    WHERE p.created_at >= ?
      AND (r.completed_at IS NOT NULL OR p.state = 'OPEN')
    GROUP BY r.id`,
    args: [sinceIso],
  });

  return result.rows.map((row) => {
    const requestedAt = Temporal.Instant.from(row.requested_at as string);
    const respondedAt = row.completed_at
      ? Temporal.Instant.from(row.completed_at as string)
      : null;
    const endInstant = respondedAt ?? Temporal.Now.instant();
    const reviewers = row.reviewers as string | null;

    return {
      pr: {
        number: row.number as number,
        title: row.title as string,
        url: row.url as string,
        author: row.author as string,
      },
      repo: row.repo as string,
      requestedAt,
      respondedAt,
      respondedBy: row.responded_by as string | null,
      requestedReviewers: reviewers ? reviewers.split(",") : [],
      businessHours: businessHoursElapsed(requestedAt, endInstant),
    };
  });
}
