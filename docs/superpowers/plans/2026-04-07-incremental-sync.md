# Incremental GitHub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Web Cache API blob with SQLite-backed incremental sync using cursor-based pagination for fast refreshes.

**Architecture:** New `db.ts` handles SQLite schema and queries via `node:sqlite`. New `ingest.ts` runs the review window state machine at write time. New `sync.ts` orchestrates initial and incremental fetches. Modified `github.ts` splits into PR search (no timeline) and per-PR timeline queries. `serve.tsx` reads from SQLite instead of the cache. `cache.ts` is deleted.

**Tech Stack:** Deno, `node:sqlite` (DatabaseSync), GitHub GraphQL API, Hono, Temporal API

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `db.ts` | Create | SQLite schema, connection, all CRUD and query helpers |
| `ingest.ts` | Create | Window state machine — processes timeline events into `reviews` rows |
| `sync.ts` | Create | Orchestrates initial load and incremental refresh |
| `github.ts` | Modify | Split into PR search query (no timeline, `sort:created-asc`, adds `node_id`) and new timeline-by-node-id query. Remove `fetchPullRequestsByNumber`. |
| `serve.tsx` | Modify | Replace cache imports with `db.ts` queries. Replace `backgroundRefresh` with `sync.ts`. Keep SWR cooldown. |
| `metrics.ts` | Modify | Remove `extractReviewWindows` and `ReviewWindow` type. Keep `computeStats` and `Stats`. |
| `web-data.ts` | Modify | Change imports. Input type changes from `ReviewWindow` to `ReviewWindowView` (constructed from DB rows). |
| `cache.ts` | Delete | Replaced by `db.ts` |
| `db_test.ts` | Create | Tests for schema creation and query helpers |
| `ingest_test.ts` | Create | Tests for window state machine |
| `metrics_test.ts` | Modify | Remove `extractReviewWindows` tests, keep `computeStats` tests |
| `cache_test.ts` | Delete | No longer needed |
| `web-data_test.ts` | Modify | Update `makeWindow` helper to use new type |
| `deno.json` | Modify | Add `--unstable-node-globals` flag if needed for `node:sqlite` |

---

### Task 1: db.ts — SQLite Schema and Helpers

**Files:**
- Create: `db.ts`
- Create: `db_test.ts`

This task creates the full database module: schema creation, PR CRUD, review CRUD, cursor management, and the read-path query that constructs `ReviewWindowView` objects from joined rows.

**Types used throughout the plan:**

```typescript
// db.ts — exported types
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

export interface ReviewWindowView {
  pr: { number: number; title: string; url: string; author: string };
  repo: string;
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  requestedReviewers: string[];
  businessHours: number;
}
```

- [ ] **Step 1: Write failing test for schema creation**

Create `db_test.ts`:

```typescript
import { afterEach, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createSchema } from "./db.ts";

describe("createSchema", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("creates all tables", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = tables.map((row) => row.name);

    assertEquals(tableNames.includes("pull_requests"), true);
    assertEquals(tableNames.includes("reviews"), true);
    assertEquals(tableNames.includes("review_requested_reviewers"), true);
    assertEquals(tableNames.includes("repo_cursors"), true);
    assertEquals(tableNames.includes("metadata"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: FAIL — `createSchema` not exported from `db.ts`

- [ ] **Step 3: Implement createSchema and database connection**

Create `db.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function createSchema(database: DatabaseSync): void {
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
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      responded_by TEXT,
      FOREIGN KEY (repo, pr_number) REFERENCES pull_requests(repo, number)
    );

    CREATE TABLE IF NOT EXISTS review_requested_reviewers (
      review_id INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      PRIMARY KEY (review_id, reviewer),
      FOREIGN KEY (review_id) REFERENCES reviews(id)
    );

    CREATE TABLE IF NOT EXISTS repo_cursors (
      repo TEXT PRIMARY KEY,
      prs_cursor TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA foreign_keys=ON");
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let database: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!database) {
    database = new DatabaseSync("pulse.db");
    createSchema(database);
  }
  return database;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for PR upsert and query**

Add to `db_test.ts`:

```typescript
import { createSchema, upsertPullRequest, getOpenPullRequests } from "./db.ts";

describe("upsertPullRequest", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("inserts a new pull request", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "canac",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const rows = database.prepare("SELECT * FROM pull_requests").all() as {
      repo: string;
      number: number;
      node_id: string;
      title: string;
      author: string;
      state: string;
    }[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].repo, "mpdx-react");
    assertEquals(rows[0].number, 42);
    assertEquals(rows[0].node_id, "PR_abc123");
    assertEquals(rows[0].author, "canac");
  });

  it("updates mutable fields on conflict", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "canac",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug (v2)",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "canac",
      state: "MERGED",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const rows = database.prepare("SELECT * FROM pull_requests").all() as {
      title: string;
      state: string;
    }[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].title, "Fix bug (v2)");
    assertEquals(rows[0].state, "MERGED");
  });
});

describe("getOpenPullRequests", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("returns only OPEN pull requests", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 1,
      nodeId: "PR_1",
      title: "Open PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/1",
      author: "canac",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 2,
      nodeId: "PR_2",
      title: "Merged PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/2",
      author: "canac",
      state: "MERGED",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const openPRs = getOpenPullRequests(database);
    assertEquals(openPRs.length, 1);
    assertEquals(openPRs[0].number, 1);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: FAIL — `upsertPullRequest` and `getOpenPullRequests` not exported

- [ ] **Step 7: Implement upsertPullRequest and getOpenPullRequests**

Add to `db.ts`:

```typescript
// ---------------------------------------------------------------------------
// Pull Request CRUD
// ---------------------------------------------------------------------------

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

export function upsertPullRequest(
  database: DatabaseSync,
  input: UpsertPullRequestInput,
): void {
  database
    .prepare(
      `INSERT INTO pull_requests (repo, number, node_id, title, url, author, state, is_draft, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title,
         state = excluded.state,
         is_draft = excluded.is_draft`,
    )
    .run(
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

export function getOpenPullRequests(database: DatabaseSync): PullRequestRow[] {
  return database
    .prepare("SELECT * FROM pull_requests WHERE state = 'OPEN'")
    .all() as PullRequestRow[];
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: PASS

- [ ] **Step 9: Write failing tests for review CRUD**

Add to `db_test.ts`:

```typescript
import {
  createSchema,
  upsertPullRequest,
  getOpenPullRequests,
  insertReview,
  addReviewRequestedReviewer,
  getLastReviewForPR,
  completeReview,
} from "./db.ts";

describe("review CRUD", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  function setupWithPR(): void {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "canac",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });
  }

  it("inserts a review and returns its id", () => {
    setupWithPR();

    const reviewId = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T14:00:00Z",
    });

    assertEquals(typeof reviewId, "number");
    assertEquals(reviewId > 0, true);
  });

  it("adds requested reviewers to a review", () => {
    setupWithPR();

    const reviewId = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T14:00:00Z",
    });

    addReviewRequestedReviewer(database, reviewId, "dr-bizz");
    addReviewRequestedReviewer(database, reviewId, "kegrimes");

    const rows = database
      .prepare("SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer")
      .all(reviewId) as { reviewer: string }[];
    assertEquals(rows.length, 2);
    assertEquals(rows[0].reviewer, "dr-bizz");
    assertEquals(rows[1].reviewer, "kegrimes");
  });

  it("getLastReviewForPR returns null when no reviews exist", () => {
    setupWithPR();

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview, null);
  });

  it("getLastReviewForPR returns the most recent review", () => {
    setupWithPR();

    insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T14:00:00Z",
    });
    insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T16:00:00Z",
    });

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.requested_at, "2026-03-30T16:00:00Z");
  });

  it("completeReview sets completed_at and responded_by", () => {
    setupWithPR();

    const reviewId = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T14:00:00Z",
    });

    completeReview(database, reviewId, "2026-03-30T15:00:00Z", "dr-bizz");

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, "2026-03-30T15:00:00Z");
    assertEquals(lastReview!.responded_by, "dr-bizz");
  });
});
```

- [ ] **Step 10: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: FAIL — `insertReview`, `addReviewRequestedReviewer`, `getLastReviewForPR`, `completeReview` not exported

- [ ] **Step 11: Implement review CRUD**

Add to `db.ts`:

```typescript
// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------

export interface InsertReviewInput {
  repo: string;
  prNumber: number;
  requestedAt: string;
}

export function insertReview(
  database: DatabaseSync,
  input: InsertReviewInput,
): number {
  const result = database
    .prepare(
      "INSERT INTO reviews (repo, pr_number, requested_at) VALUES (?, ?, ?)",
    )
    .run(input.repo, input.prNumber, input.requestedAt);
  return Number(result.lastInsertRowid);
}

export function addReviewRequestedReviewer(
  database: DatabaseSync,
  reviewId: number,
  reviewer: string,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO review_requested_reviewers (review_id, reviewer) VALUES (?, ?)",
    )
    .run(reviewId, reviewer);
}

export function getLastReviewForPR(
  database: DatabaseSync,
  repo: string,
  prNumber: number,
): ReviewRow | null {
  const row = database
    .prepare(
      "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY id DESC LIMIT 1",
    )
    .get(repo, prNumber) as ReviewRow | undefined;
  return row ?? null;
}

export function completeReview(
  database: DatabaseSync,
  reviewId: number,
  completedAt: string,
  respondedBy: string,
): void {
  database
    .prepare("UPDATE reviews SET completed_at = ?, responded_by = ? WHERE id = ?")
    .run(completedAt, respondedBy, reviewId);
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: PASS

- [ ] **Step 13: Write failing tests for cursor and metadata helpers**

Add to `db_test.ts`:

```typescript
import {
  createSchema,
  getRepoCursor,
  setRepoCursor,
  updateTimelineCursor,
  upsertPullRequest,
  getOpenPullRequests,
  getLastFetchedAt,
  setLastFetchedAt,
} from "./db.ts";

describe("cursor helpers", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("getRepoCursor returns null when no cursor exists", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    assertEquals(getRepoCursor(database, "mpdx-react"), null);
  });

  it("setRepoCursor and getRepoCursor round-trip", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    setRepoCursor(database, "mpdx-react", "cursor_abc");
    assertEquals(getRepoCursor(database, "mpdx-react"), "cursor_abc");
  });

  it("setRepoCursor overwrites existing cursor", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    setRepoCursor(database, "mpdx-react", "cursor_abc");
    setRepoCursor(database, "mpdx-react", "cursor_def");
    assertEquals(getRepoCursor(database, "mpdx-react"), "cursor_def");
  });

  it("updateTimelineCursor sets cursor on pull request", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "canac",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    updateTimelineCursor(database, "mpdx-react", 42, "timeline_cursor_xyz");

    const openPRs = getOpenPullRequests(database);
    assertEquals(openPRs[0].timeline_cursor, "timeline_cursor_xyz");
  });
});

describe("metadata helpers", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("getLastFetchedAt returns null when not set", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    assertEquals(getLastFetchedAt(database), null);
  });

  it("setLastFetchedAt and getLastFetchedAt round-trip", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);
    const date = new Date("2026-03-30T14:00:00Z");
    setLastFetchedAt(database, date);
    const result = getLastFetchedAt(database);
    assertEquals(result!.toISOString(), date.toISOString());
  });
});
```

- [ ] **Step 14: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: FAIL

- [ ] **Step 15: Implement cursor and metadata helpers**

Add to `db.ts`:

```typescript
// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

export function getRepoCursor(
  database: DatabaseSync,
  repo: string,
): string | null {
  const row = database
    .prepare("SELECT prs_cursor FROM repo_cursors WHERE repo = ?")
    .get(repo) as { prs_cursor: string } | undefined;
  return row?.prs_cursor ?? null;
}

export function setRepoCursor(
  database: DatabaseSync,
  repo: string,
  cursor: string,
): void {
  database
    .prepare(
      "INSERT INTO repo_cursors (repo, prs_cursor) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET prs_cursor = excluded.prs_cursor",
    )
    .run(repo, cursor);
}

export function updateTimelineCursor(
  database: DatabaseSync,
  repo: string,
  prNumber: number,
  cursor: string,
): void {
  database
    .prepare(
      "UPDATE pull_requests SET timeline_cursor = ? WHERE repo = ? AND number = ?",
    )
    .run(cursor, repo, prNumber);
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

export function getLastFetchedAt(database: DatabaseSync): Date | null {
  const row = database
    .prepare("SELECT value FROM metadata WHERE key = 'last_fetched_at'")
    .get() as { value: string } | undefined;
  return row ? new Date(row.value) : null;
}

export function setLastFetchedAt(
  database: DatabaseSync,
  date: Date,
): void {
  database
    .prepare(
      "INSERT INTO metadata (key, value) VALUES ('last_fetched_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .run(date.toISOString());
}
```

- [ ] **Step 16: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: PASS

- [ ] **Step 17: Write failing test for loadReviewWindows**

Add to `db_test.ts`:

```typescript
import { loadReviewWindows } from "./db.ts";

describe("loadReviewWindows", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("returns closed review windows with business hours", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 42,
      nodeId: "PR_abc123",
      title: "Fix bug",
      url: "https://github.com/CruGlobal/mpdx-react/pull/42",
      author: "someauthor",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const reviewId = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 42,
      requestedAt: "2026-03-30T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId, "canac");
    completeReview(database, reviewId, "2026-03-30T15:00:00Z", "canac");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");

    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 42);
    assertEquals(windows[0].pr.title, "Fix bug");
    assertEquals(windows[0].pr.author, "someauthor");
    assertEquals(windows[0].respondedBy, "canac");
    assertEquals(windows[0].requestedReviewers, ["canac"]);
    assertEquals(windows[0].businessHours >= 0, true);
    assertEquals(
      windows[0].requestedAt,
      Temporal.Instant.from("2026-03-30T14:00:00Z"),
    );
    assertEquals(
      windows[0].respondedAt,
      Temporal.Instant.from("2026-03-30T15:00:00Z"),
    );
  });

  it("returns open review windows only for OPEN PRs", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 1,
      nodeId: "PR_1",
      title: "Open PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/1",
      author: "someauthor",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 2,
      nodeId: "PR_2",
      title: "Merged PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/2",
      author: "someauthor",
      state: "MERGED",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const reviewId1 = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 1,
      requestedAt: "2026-03-30T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId1, "canac");

    const reviewId2 = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 2,
      requestedAt: "2026-03-30T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId2, "dr-bizz");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");

    // Only the open window on the OPEN PR should be returned
    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 1);
    assertEquals(windows[0].respondedAt, null);
  });

  it("filters by lookback cutoff using created_at", () => {
    database = new DatabaseSync(":memory:");
    createSchema(database);

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 1,
      nodeId: "PR_1",
      title: "Old PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/1",
      author: "someauthor",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-01-01T14:00:00Z",
    });

    upsertPullRequest(database, {
      repo: "mpdx-react",
      number: 2,
      nodeId: "PR_2",
      title: "Recent PR",
      url: "https://github.com/CruGlobal/mpdx-react/pull/2",
      author: "someauthor",
      state: "OPEN",
      isDraft: false,
      createdAt: "2026-03-30T14:00:00Z",
    });

    const reviewId1 = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 1,
      requestedAt: "2026-01-01T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId1, "canac");
    completeReview(database, reviewId1, "2026-01-01T15:00:00Z", "canac");

    const reviewId2 = insertReview(database, {
      repo: "mpdx-react",
      prNumber: 2,
      requestedAt: "2026-03-30T14:00:00Z",
    });
    addReviewRequestedReviewer(database, reviewId2, "dr-bizz");
    completeReview(database, reviewId2, "2026-03-30T15:00:00Z", "dr-bizz");

    const windows = loadReviewWindows(database, "2026-03-01T00:00:00Z");

    assertEquals(windows.length, 1);
    assertEquals(windows[0].pr.number, 2);
  });
});
```

- [ ] **Step 18: Run test to verify it fails**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: FAIL — `loadReviewWindows` not exported

- [ ] **Step 19: Implement loadReviewWindows**

Add to `db.ts`:

```typescript
import { businessHoursElapsed } from "./business-hours.ts";

// ---------------------------------------------------------------------------
// Review Window View (read path)
// ---------------------------------------------------------------------------

export interface ReviewWindowView {
  pr: { number: number; title: string; url: string; author: string };
  repo: string;
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  requestedReviewers: string[];
  businessHours: number;
}

export function loadReviewWindows(
  database: DatabaseSync,
  sinceIso: string,
): ReviewWindowView[] {
  const rows = database
    .prepare(
      `SELECT r.id, r.repo, r.pr_number, r.requested_at, r.completed_at, r.responded_by,
              p.title, p.url, p.author, p.number, p.state,
              GROUP_CONCAT(rr.reviewer) AS reviewers
       FROM reviews r
       JOIN pull_requests p ON r.repo = p.repo AND r.pr_number = p.number
       LEFT JOIN review_requested_reviewers rr ON r.id = rr.review_id
       WHERE p.created_at >= ?
         AND (r.completed_at IS NOT NULL OR p.state = 'OPEN')
       GROUP BY r.id`,
    )
    .all(sinceIso) as Array<{
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
```

- [ ] **Step 20: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts`
Expected: PASS

- [ ] **Step 21: Commit**

```bash
git add db.ts db_test.ts
git commit -m "feat: add SQLite database module with schema, CRUD, and review window queries"
```

---

### Task 2: ingest.ts — Window State Machine

**Files:**
- Create: `ingest.ts`
- Create: `ingest_test.ts`

The state machine processes timeline events for a PR and creates/updates rows in the `reviews` and `review_requested_reviewers` tables. It runs at ingestion time (when new timeline events arrive from GitHub).

- [ ] **Step 1: Write failing test for basic request-then-review flow**

Create `ingest_test.ts`:

```typescript
import { afterEach, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  createSchema,
  upsertPullRequest,
  getLastReviewForPR,
} from "./db.ts";
import { ingestTimelineEvents } from "./ingest.ts";
import type { TimelineItem } from "./github.ts";

function setupDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  createSchema(database);

  upsertPullRequest(database, {
    repo: "mpdx-react",
    number: 42,
    nodeId: "PR_abc123",
    title: "Fix bug",
    url: "https://github.com/CruGlobal/mpdx-react/pull/42",
    author: "someauthor",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-03-30T14:00:00Z",
  });

  return database;
}

describe("ingestTimelineEvents", () => {
  let database: DatabaseSync;

  afterEach(() => {
    database.close();
  });

  it("creates a review window from request + review", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T15:00:00Z",
        author: { login: "canac" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, "2026-03-30T15:00:00Z");
    assertEquals(lastReview!.responded_by, "canac");

    const reviewers = database
      .prepare(
        "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ?",
      )
      .all(lastReview!.id) as { reviewer: string }[];
    assertEquals(reviewers.length, 1);
    assertEquals(reviewers[0].reviewer, "canac");
  });

  it("ignores review requests to non-team members", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "external-contributor" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview, null);
  });

  it("ignores duplicate review requests when window is open", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:30:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T15:00:00Z",
        author: { login: "canac" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const reviews = database
      .prepare("SELECT * FROM reviews WHERE repo = ? AND pr_number = ?")
      .all("mpdx-react", 42) as { id: number }[];
    // Should be one review window, not two
    assertEquals(reviews.length, 1);

    // But both reviewers should be tracked
    const reviewers = database
      .prepare(
        "SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer",
      )
      .all(reviews[0].id) as { reviewer: string }[];
    assertEquals(reviewers.length, 2);
    assertEquals(reviewers[0].reviewer, "canac");
    assertEquals(reviewers[1].reviewer, "dr-bizz");
  });

  it("ignores reviews from PR author", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "IssueComment",
        createdAt: "2026-03-30T14:30:00Z",
        author: { login: "someauthor" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, null);
  });

  it("ignores reviews from non-team members", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T14:30:00Z",
        author: { login: "external-contributor" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, null);
  });

  it("IssueComment from team member closes window", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "IssueComment",
        createdAt: "2026-03-30T15:30:00Z",
        author: { login: "dr-bizz" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, "2026-03-30T15:30:00Z");
    assertEquals(lastReview!.responded_by, "dr-bizz");
  });

  it("two review cycles produce two review rows", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T15:00:00Z",
        author: { login: "canac" },
      },
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T16:00:00Z",
        requestedReviewer: { login: "wjames111" },
      },
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T17:00:00Z",
        author: { login: "wjames111" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const reviews = database
      .prepare(
        "SELECT * FROM reviews WHERE repo = ? AND pr_number = ? ORDER BY id",
      )
      .all("mpdx-react", 42) as {
      completed_at: string | null;
      responded_by: string | null;
    }[];

    assertEquals(reviews.length, 2);
    assertEquals(reviews[0].responded_by, "canac");
    assertEquals(reviews[1].responded_by, "wjames111");
  });

  it("ignores review/comment when no window is open", () => {
    database = setupDatabase();

    const events: TimelineItem[] = [
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T15:00:00Z",
        author: { login: "canac" },
      },
      {
        __typename: "IssueComment",
        createdAt: "2026-03-30T15:30:00Z",
        author: { login: "dr-bizz" },
      },
    ];

    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", events);

    const reviews = database
      .prepare("SELECT * FROM reviews WHERE repo = ? AND pr_number = ?")
      .all("mpdx-react", 42);
    assertEquals(reviews.length, 0);
  });

  it("appends to existing state from previous ingestion", () => {
    database = setupDatabase();

    // First ingestion: opens a window
    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
    ]);

    // Second ingestion: closes the window
    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", [
      {
        __typename: "PullRequestReview",
        createdAt: "2026-03-30T15:00:00Z",
        author: { login: "canac" },
      },
    ]);

    const lastReview = getLastReviewForPR(database, "mpdx-react", 42);
    assertEquals(lastReview!.completed_at, "2026-03-30T15:00:00Z");
    assertEquals(lastReview!.responded_by, "canac");
  });

  it("ignores review request when open window exists from previous ingestion", () => {
    database = setupDatabase();

    // First ingestion: opens a window
    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:00:00Z",
        requestedReviewer: { login: "canac" },
      },
    ]);

    // Second ingestion: another review request (should be ignored, window already open)
    ingestTimelineEvents(database, "mpdx-react", 42, "someauthor", [
      {
        __typename: "ReviewRequestedEvent",
        createdAt: "2026-03-30T14:30:00Z",
        requestedReviewer: { login: "dr-bizz" },
      },
    ]);

    const reviews = database
      .prepare("SELECT * FROM reviews WHERE repo = ? AND pr_number = ?")
      .all("mpdx-react", 42);
    // Still just one review window
    assertEquals(reviews.length, 1);

    // But dr-bizz should be added to the existing window's reviewers
    const reviewers = database
      .prepare("SELECT reviewer FROM review_requested_reviewers WHERE review_id = ? ORDER BY reviewer")
      .all((reviews[0] as { id: number }).id) as { reviewer: string }[];
    assertEquals(reviewers.length, 2);
    assertEquals(reviewers[0].reviewer, "canac");
    assertEquals(reviewers[1].reviewer, "dr-bizz");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-env ingest_test.ts`
Expected: FAIL — `ingestTimelineEvents` not exported

- [ ] **Step 3: Implement ingestTimelineEvents**

Create `ingest.ts`:

```typescript
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
      const requestedLogin = event.requestedReviewer?.login;
      if (!requestedLogin || !TEAM_MEMBER_SET.has(requestedLogin)) {
        continue;
      }

      if (hasOpenWindow) {
        // Window already open — just add the reviewer to the existing window
        addReviewRequestedReviewer(database, lastReview!.id, requestedLogin);
        continue;
      }

      // Open a new window
      const reviewId = insertReview(database, {
        repo,
        prNumber,
        requestedAt: event.createdAt,
      });
      addReviewRequestedReviewer(database, reviewId, requestedLogin);
      continue;
    }

    if (
      event.__typename === "PullRequestReview" ||
      event.__typename === "IssueComment"
    ) {
      if (!hasOpenWindow) {
        continue;
      }

      const responderLogin = event.author?.login ?? "";
      if (responderLogin === prAuthor || !TEAM_MEMBER_SET.has(responderLogin)) {
        continue;
      }

      completeReview(
        database,
        lastReview!.id,
        event.createdAt,
        responderLogin,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-env ingest_test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ingest.ts ingest_test.ts
git commit -m "feat: add ingestion-time window state machine"
```

---

### Task 3: github.ts — Modified GraphQL Queries

**Files:**
- Modify: `github.ts`

Split the current single query into two: a PR search query (no timeline, adds `id`/`node_id`, uses `sort:created-asc`) and a timeline-by-node-id query. Remove `fetchPullRequestsByNumber`.

- [ ] **Step 1: Update Zod schemas and types**

In `github.ts`, update `PullRequestSchema` to include `id` (node ID) and remove `timelineItems`:

Replace the `PullRequestSchema` definition (lines 36-48) with:

```typescript
const PullRequestSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  author: ActorSchema,
});
```

Keep `author` nullable at the Zod level — the GitHub API can return null for deleted/ghost users. The DB requires `NOT NULL`, so `sync.ts` converts null to `"ghost"` before inserting.

Also remove the `LOOKBACK_DAYS` import from the top of the file (no longer used after removing the date filter from `fetchAllPagesForRepo`).

Add a new schema for timeline responses:

```typescript
const TimelineResponseSchema = z.object({
  data: z.object({
    node: z.object({
      title: z.string(),
      state: z.enum(["OPEN", "MERGED", "CLOSED"]),
      isDraft: z.boolean(),
      timelineItems: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(TimelineItemSchema),
      }),
    }),
  }),
});
```

Update the `QueryResponseSchema` if the response shape for PR search changes (the `pullRequests` connection stays the same structurally, just without timeline fields per PR).

- [ ] **Step 2: Update PR search query**

Replace `PR_FIELDS` (lines 71-86) with:

```typescript
const PR_FIELDS = `
  id number title url createdAt isDraft state
  author { login }
`;
```

Replace `PULL_REQUESTS_QUERY` (lines 88-104) with:

```typescript
const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 100
        after: $cursor
        states: $states
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${PR_FIELDS}
        }
      }
    }
  }
`;
```

Key changes: `direction: ASC` (was `DESC`), no `timelineItems` in `PR_FIELDS`, `id` added.

- [ ] **Step 3: Add timeline query**

Add the new query and fetch function:

```typescript
const TIMELINE_QUERY = `
  query($nodeId: ID!, $cursor: String) {
    node(id: $nodeId) {
      ... on PullRequest {
        title
        state
        isDraft
        timelineItems(
          first: 100
          after: $cursor
          itemTypes: [REVIEW_REQUESTED_EVENT PULL_REQUEST_REVIEW ISSUE_COMMENT]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
            ... on PullRequestReview { createdAt author { login } }
            ... on IssueComment { createdAt author { login } }
          }
        }
      }
    }
  }
`;

export interface TimelineResult {
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  events: TimelineItem[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export async function fetchTimeline(
  token: string,
  nodeId: string,
  cursor: string | null,
): Promise<TimelineResult> {
  const json = await graphqlRequest(token, TIMELINE_QUERY, {
    nodeId,
    cursor,
  });

  const parsed = TimelineResponseSchema.parse(json);
  const { title, state, isDraft, timelineItems } = parsed.data.node;

  return {
    title,
    state,
    isDraft,
    events: timelineItems.nodes,
    endCursor: timelineItems.pageInfo.endCursor,
    hasNextPage: timelineItems.pageInfo.hasNextPage,
  };
}
```

- [ ] **Step 4: Update fetchAllPagesForRepo**

The function signature stays the same, but it now returns PRs without timeline data. Update the return type and remove draft/date filtering (that will be handled by the caller in `sync.ts` since we're now using `ASC` ordering and cursor resumption).

Replace `fetchAllPagesForRepo` (lines 146-188) with:

```typescript
export interface FetchPagesResult {
  pullRequests: Array<PullRequest & { repo: string }>;
  endCursor: string | null;
}

async function fetchAllPagesForRepo(
  token: string,
  repoName: string,
  states: ("OPEN" | "MERGED" | "CLOSED")[],
  startCursor: string | null,
): Promise<FetchPagesResult> {
  const pullRequests: Array<PullRequest & { repo: string }> = [];
  let cursor = startCursor;

  while (true) {
    const json = await graphqlRequest(token, PULL_REQUESTS_QUERY, {
      owner: GITHUB_ORG,
      name: repoName,
      cursor,
      states,
    });

    const { pullRequests: pullRequestsPage } = QueryResponseSchema.parse(json)
      .data.repository;

    for (const pullRequest of pullRequestsPage.nodes) {
      pullRequests.push({ ...pullRequest, repo: repoName });
    }

    cursor = pullRequestsPage.pageInfo.endCursor;

    if (!pullRequestsPage.pageInfo.hasNextPage) {
      break;
    }
  }

  return { pullRequests, endCursor: cursor };
}
```

- [ ] **Step 5: Update fetchPullRequests and remove fetchPullRequestsByNumber**

Replace `fetchPullRequests` (lines 200-222) with:

```typescript
export async function fetchPullRequests(
  token: string,
  options: {
    states?: ("OPEN" | "MERGED" | "CLOSED")[];
    cursors?: Map<string, string | null>;
  } = {},
): Promise<Map<string, FetchPagesResult>> {
  const states = options.states ?? ALL_STATES;
  const cursors = options.cursors ?? new Map();

  const results = new Map<string, FetchPagesResult>();

  const fetches = REPOS.map(async (repoName) => {
    const startCursor = cursors.get(repoName) ?? null;
    const result = await fetchAllPagesForRepo(
      token,
      repoName,
      states,
      startCursor,
    );
    results.set(repoName, result);
  });

  await Promise.all(fetches);
  return results;
}
```

Delete `fetchPullRequestsByNumber` entirely (lines 224-266).

- [ ] **Step 6: Update type export**

The `PullRequest` type no longer includes `timelineItems`. The `TimelineItem` type is still exported (used by `ingest.ts`). Update the export:

```typescript
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;
```

- [ ] **Step 7: Run full test suite to check for compilation errors**

Run: `deno test --allow-read --allow-write --allow-env db_test.ts ingest_test.ts`
Expected: PASS (these tests don't depend on the old github.ts exports). Other tests will fail — that's expected and will be fixed in later tasks.

- [ ] **Step 8: Commit**

```bash
git add github.ts
git commit -m "feat: split GraphQL into PR search and timeline queries, add ASC ordering"
```

---

### Task 4: sync.ts — Load Orchestration

**Files:**
- Create: `sync.ts`

Orchestrates the initial load and incremental refresh. This replaces the `backgroundRefresh()` function in `serve.tsx`.

- [ ] **Step 1: Implement sync module**

Create `sync.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import { REPOS } from "./config.ts";
import {
  type FetchPagesResult,
  fetchPullRequests,
  fetchTimeline,
} from "./github.ts";
import {
  getOpenPullRequests,
  getRepoCursor,
  type PullRequestRow,
  setLastFetchedAt,
  setRepoCursor,
  updateTimelineCursor,
  upsertPullRequest,
} from "./db.ts";
import { ingestTimelineEvents } from "./ingest.ts";

async function fetchAndIngestTimeline(
  token: string,
  database: DatabaseSync,
  pullRequest: PullRequestRow,
): Promise<void> {
  let cursor = pullRequest.timeline_cursor;

  while (true) {
    const timeline = await fetchTimeline(
      token,
      pullRequest.node_id,
      cursor,
    );

    // Update mutable PR fields
    upsertPullRequest(database, {
      repo: pullRequest.repo,
      number: pullRequest.number,
      nodeId: pullRequest.node_id,
      title: timeline.title,
      url: pullRequest.url,
      author: pullRequest.author,
      state: timeline.state,
      isDraft: timeline.isDraft,
      createdAt: pullRequest.created_at,
    });

    ingestTimelineEvents(
      database,
      pullRequest.repo,
      pullRequest.number,
      pullRequest.author,
      timeline.events,
    );

    cursor = timeline.endCursor;

    if (!timeline.hasNextPage) {
      break;
    }
  }

  if (cursor) {
    updateTimelineCursor(
      database,
      pullRequest.repo,
      pullRequest.number,
      cursor,
    );
  }
}

async function ingestNewPRs(
  token: string,
  database: DatabaseSync,
  repoResults: Map<string, FetchPagesResult>,
): Promise<void> {
  for (const [repoName, result] of repoResults) {
    for (const pullRequest of result.pullRequests) {
      if (pullRequest.isDraft) {
        continue;
      }

      upsertPullRequest(database, {
        repo: repoName,
        number: pullRequest.number,
        nodeId: pullRequest.id,
        title: pullRequest.title,
        url: pullRequest.url,
        author: pullRequest.author?.login ?? "ghost",
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        createdAt: pullRequest.createdAt,
      });

      // Fetch full timeline for new PRs
      const insertedPR: PullRequestRow = {
        repo: repoName,
        number: pullRequest.number,
        node_id: pullRequest.id,
        title: pullRequest.title,
        url: pullRequest.url,
        author: pullRequest.author?.login ?? "ghost",
        state: pullRequest.state,
        is_draft: pullRequest.isDraft ? 1 : 0,
        created_at: pullRequest.createdAt,
        timeline_cursor: null,
      };

      await fetchAndIngestTimeline(token, database, insertedPR);
    }

    if (result.endCursor) {
      setRepoCursor(database, repoName, result.endCursor);
    }
  }
}

export async function initialLoad(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  const repoResults = await fetchPullRequests(token);
  await ingestNewPRs(token, database, repoResults);
  setLastFetchedAt(database, new Date());
}

export async function incrementalRefresh(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  const cursors = new Map<string, string | null>();
  for (const repoName of REPOS) {
    cursors.set(repoName, getRepoCursor(database, repoName));
  }

  // Stream 1: Fetch new PRs using stored cursors
  const newPRsPromise = fetchPullRequests(token, { cursors }).then(
    (repoResults) => ingestNewPRs(token, database, repoResults),
  );

  // Stream 2: Refresh timelines for open PRs
  const openPRs = getOpenPullRequests(database);
  const timelinePromises = openPRs.map((pullRequest) =>
    fetchAndIngestTimeline(token, database, pullRequest)
  );

  await Promise.all([newPRsPromise, ...timelinePromises]);
  setLastFetchedAt(database, new Date());
}

export async function sync(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  const hasData = getRepoCursor(database, REPOS[0]) !== null;

  if (hasData) {
    await incrementalRefresh(token, database);
  } else {
    await initialLoad(token, database);
  }
}
```

- [ ] **Step 2: Run compilation check**

Run: `deno check sync.ts`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add sync.ts
git commit -m "feat: add sync orchestration for initial and incremental loads"
```

---

### Task 5: Read Path and Wiring

**Files:**
- Modify: `serve.tsx`
- Modify: `web-data.ts`
- Modify: `metrics.ts`
- Modify: `web-data_test.ts`

Wire `serve.tsx` to read from SQLite via `loadReviewWindows`, replace `backgroundRefresh` with `sync`, and update `web-data.ts` and `metrics.ts` to use the new `ReviewWindowView` type.

- [ ] **Step 1: Update metrics.ts**

Remove `extractReviewWindows`, the `ReviewWindow` type, and the `TEAM_MEMBER_SET` constant. Keep `computeStats` and `Stats`. Remove the `PullRequest` and `businessHoursElapsed` imports since they're no longer needed.

Replace the entire file with:

```typescript
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Stats {
  median: number;
  p75: number;
  p90: number;
  count: number;
}

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { median: 0, p75: 0, p90: 0, count: 0 };
  }

  const sorted = values.toSorted((numA, numB) => numA - numB);
  const count = sorted.length;

  const midIndex = Math.floor(count / 2);
  const median = count % 2 === 1
    ? sorted[midIndex]
    : (sorted[midIndex - 1] + sorted[midIndex]) / 2;

  const p75Index = Math.floor((count - 1) * 0.75);
  const p75 = sorted[p75Index];
  const p90Index = Math.floor((count - 1) * 0.9);
  const p90 = sorted[p90Index];

  return { median, p75, p90, count };
}
```

- [ ] **Step 2: Update metrics_test.ts**

Remove all `extractReviewWindows` tests and the `makePR` helper. Keep only the `computeStats` describe block. Remove unused imports.

Replace the entire file with:

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { computeStats } from "./metrics.ts";

describe("computeStats", () => {
  it("array of 10 values has correct median (5.5), P75 (7), P90 (9), count (10)", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stats = computeStats(values);

    assertEquals(stats.count, 10);
    assertEquals(stats.median, 5.5);
    assertEquals(stats.p75, 7);
    assertEquals(stats.p90, 9);
  });

  it("single value has that value for median, P75, and P90", () => {
    const stats = computeStats([42]);

    assertEquals(stats.count, 1);
    assertEquals(stats.median, 42);
    assertEquals(stats.p75, 42);
    assertEquals(stats.p90, 42);
  });

  it("empty array returns all zeros", () => {
    const stats = computeStats([]);

    assertEquals(stats.median, 0);
    assertEquals(stats.p75, 0);
    assertEquals(stats.p90, 0);
    assertEquals(stats.count, 0);
  });
});
```

- [ ] **Step 3: Update web-data.ts**

Change imports from `ReviewWindow` to `ReviewWindowView`. The functions operate on the same shape, so the logic is unchanged.

Replace the imports and type references:

```typescript
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
```

- [ ] **Step 4: Update web-data_test.ts**

Change imports and the `makeWindow` helper to use `ReviewWindowView`:

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import type { ReviewWindowView } from "./db.ts";

function makeWindow(overrides: Partial<ReviewWindowView> = {}): ReviewWindowView {
  return {
    pr: {
      number: 1,
      title: "Test PR",
      url: "https://github.com/CruGlobal/repo/pull/1",
      author: "author",
    },
    repo: "mpdx-react",
    requestedAt: Temporal.Instant.from("2026-03-30T14:00:00Z"),
    respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
    respondedBy: "canac",
    requestedReviewers: ["canac"],
    businessHours: 1,
    ...overrides,
  };
}
```

The rest of the test file stays the same (the test assertions don't reference any removed fields).

- [ ] **Step 5: Update component imports**

In `components/WaitingPage.tsx`, change the `ReviewWindow` import to `ReviewWindowView`:

```typescript
import type { ReviewWindowView } from "../db.ts";
```

Update the `WaitingPageData` interface:

```typescript
interface WaitingPageData {
  waitingByReviewer: Map<string, ReviewWindowView[]>;
  lastUpdated: Date | null;
}
```

In `components/ResponseTimesPage.tsx`, update the import:

```typescript
import type { ReviewerDetail, WeekBucket } from "../web-data.ts";
```

(This import already doesn't reference `ReviewWindow` directly — it uses `ReviewerDetail` which now contains `ReviewWindowView[]` instead of `ReviewWindow[]`. The component accesses the same fields, so no other changes needed.)

- [ ] **Step 6: Rewrite serve.tsx**

Replace the entire file:

```typescript
import { Hono } from "hono";
import { getToken, LOOKBACK_DAYS } from "./config.ts";
import { getDb, getLastFetchedAt, loadReviewWindows, type ReviewWindowView } from "./db.ts";
import { sync } from "./sync.ts";
import { computeStats } from "./metrics.ts";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import { WaitingPage } from "./components/WaitingPage.tsx";
import { ResponseTimesPage } from "./components/ResponseTimesPage.tsx";

const SWR_COOLDOWN_MS = 5 * 60 * 1000;
let lastFetchedAt = 0;

function backgroundRefresh(): void {
  const token = getToken();
  const database = getDb();
  sync(token, database).then(() => {
    console.log("Background refresh complete");
  }).catch((error) => {
    console.error("Background refresh failed:", error);
  });
}

function maybeRefreshInBackground(): void {
  if (Date.now() - lastFetchedAt > SWR_COOLDOWN_MS) {
    lastFetchedAt = Date.now();
    backgroundRefresh();
  }
}

function loadWindowsAndMeta(): {
  allWindows: ReviewWindowView[];
  lastUpdated: Date | null;
} {
  const database = getDb();
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });

  const allWindows = loadReviewWindows(database, since.toString());
  const lastUpdated = getLastFetchedAt(database);

  return { allWindows, lastUpdated };
}

const app = new Hono();

app.use(async (ctx, next) => {
  try {
    const filePath = `./static${ctx.req.path}`;
    const stat = await Deno.stat(filePath);
    if (!stat.isFile) {
      return await next();
    }
    const file = await Deno.open(filePath, { read: true });
    const headers: Record<string, string> = {};
    if (filePath.endsWith(".css")) {
      headers["content-type"] = "text/css; charset=utf-8";
    }
    return new Response(file.readable, { headers });
  } catch {
    return await next();
  }
});

app.get("/", (ctx) => {
  const { allWindows, lastUpdated } = loadWindowsAndMeta();
  maybeRefreshInBackground();
  return ctx.html(
    <WaitingPage
      waitingByReviewer={groupWaitingByReviewer(allWindows)}
      lastUpdated={lastUpdated}
    />,
  );
});

app.get("/response-times", (ctx) => {
  const { allWindows, lastUpdated } = loadWindowsAndMeta();
  const closedWindows = allWindows.filter((window) =>
    window.respondedAt !== null
  );
  maybeRefreshInBackground();
  return ctx.html(
    <ResponseTimesPage
      overall={computeStats(
        closedWindows.map((window) => window.businessHours),
      )}
      trend={computeWeeklyTrend(allWindows)}
      reviewerDetails={computeReviewerDetails(allWindows)}
      lastUpdated={lastUpdated}
    />,
  );
});

export function startServer(): void {
  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;
  Deno.serve({ port }, app.fetch);
}
```

Key changes:
- `loadWindowsAndMeta` is now synchronous (SQLite is sync)
- Route handlers are no longer async (no cache await)
- Imports from `db.ts` and `sync.ts` instead of `cache.ts`

- [ ] **Step 7: Run all tests**

Run: `deno test --allow-read --allow-write --allow-env`
Expected: All tests in `db_test.ts`, `ingest_test.ts`, `metrics_test.ts`, `web-data_test.ts`, `business-hours_test.ts` should PASS. `cache_test.ts` will fail since it imports from the old `cache.ts`.

- [ ] **Step 8: Commit**

```bash
git add serve.tsx metrics.ts metrics_test.ts web-data.ts web-data_test.ts components/WaitingPage.tsx components/ResponseTimesPage.tsx
git commit -m "feat: wire serve.tsx to SQLite read path, update types across codebase"
```

---

### Task 6: Cleanup

**Files:**
- Delete: `cache.ts`
- Delete: `cache_test.ts`
- Modify: `deno.json` (add permissions for `node:sqlite` if needed)

- [ ] **Step 1: Delete cache.ts and cache_test.ts**

```bash
rm cache.ts cache_test.ts
```

- [ ] **Step 2: Update deno.json dev task**

Add `--allow-write` to the dev task (needed for SQLite file) and add `--allow-ffi` if required by `node:sqlite`:

In `deno.json`, update the `dev` task:

```json
"dev": "deno run --watch --allow-read --allow-write --allow-net --allow-env --allow-ffi main.ts"
```

Also update the `test` task to include `--allow-ffi` if needed:

```json
"test": "deno test --allow-read --allow-write --allow-env --allow-ffi"
```

- [ ] **Step 3: Add pulse.db to .gitignore**

Check if `.gitignore` exists. If so, add `pulse.db` to it. If not, create it:

```
pulse.db
pulse.db-wal
pulse.db-shm
```

- [ ] **Step 4: Run full test suite**

Run: `deno test --allow-read --allow-write --allow-env --allow-ffi`
Expected: ALL tests PASS

- [ ] **Step 5: Run type check**

Run: `deno check main.ts`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git rm cache.ts cache_test.ts
git add deno.json .gitignore
git commit -m "chore: remove Web Cache API, update Deno config for SQLite"
```

---

### Task 7: Smoke Test

- [ ] **Step 1: Start the dev server and verify it runs**

Run: `deno task dev`
Expected: Server starts without errors. First page load triggers initial sync (will be slow). After sync completes, pages should render with data from GitHub.

If `node:sqlite` requires additional Deno flags, update `deno.json` accordingly and re-run.

- [ ] **Step 2: Verify incremental refresh**

Wait 5+ minutes or temporarily reduce `SWR_COOLDOWN_MS` for testing. Refresh the page. Check the console for "Background refresh complete" — this should happen faster than the initial load since it only fetches new data.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
