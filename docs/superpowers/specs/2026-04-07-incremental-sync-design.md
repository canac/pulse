# Incremental GitHub Sync with SQLite Cache

Replace the Web Cache API blob with a normalized SQLite database (`node:sqlite`) that supports cursor-based incremental refresh of PRs and timeline events.

## SQLite Schema

```sql
CREATE TABLE pull_requests (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL,        -- OPEN, MERGED, CLOSED
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,   -- ISO 8601
  timeline_cursor TEXT,       -- GraphQL endCursor for timeline pagination (open PRs only)
  PRIMARY KEY (repo, number)
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  requested_at TEXT NOT NULL,  -- ISO 8601
  completed_at TEXT,           -- ISO 8601, null = open window
  responded_by TEXT,           -- login, null if incomplete
  FOREIGN KEY (repo, pr_number) REFERENCES pull_requests(repo, number)
);

CREATE TABLE review_requested_reviewers (
  review_id INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  PRIMARY KEY (review_id, reviewer),
  FOREIGN KEY (review_id) REFERENCES reviews(id)
);

CREATE TABLE repo_cursors (
  repo TEXT PRIMARY KEY,
  prs_cursor TEXT NOT NULL    -- GraphQL endCursor for PR search pagination
);

CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: 'last_fetched_at' (ISO 8601)
```

## Data Loading Flow

### Initial Load

When the database has no PR data:

1. For each repo in parallel, fetch all PRs using `sort:created-asc` cursor pagination.
2. Skip draft PRs.
3. Insert each PR into `pull_requests` (including `node_id`).
4. For each PR, process timeline items through the window state machine. Insert rows into `reviews` and `review_requested_reviewers`.
5. Store the final `endCursor` per repo in `repo_cursors`.
6. Store the final timeline `endCursor` per open PR on `pull_requests.timeline_cursor`.
7. Set `last_fetched_at` in `metadata`.

### Incremental Refresh

Two parallel workstreams:

**Stream 1 -- New PRs:**
- For each repo in parallel, resume from stored `prs_cursor` with `sort:created-asc`.
- Insert new PRs and process their full timelines (same as initial load steps 3--6).
- Update `prs_cursor`.

**Stream 2 -- Open PR timeline updates:**
- Query all open PRs from the database.
- For each open PR, fetch new timeline items using `node(id)` query with the stored `timeline_cursor`.
- Fetch only `REVIEW_REQUESTED_EVENT`, `PULL_REQUEST_REVIEW`, `ISSUE_COMMENT`.
- Process new events through the window state machine against current state.
- Update `timeline_cursor`.
- Update mutable PR fields: `title`, `state`, `is_draft`.

### SWR Pattern

Keep the current 5-minute cooldown. On each request, serve from the database immediately and trigger a background incremental refresh if stale.

## GraphQL Query Changes

**PR search query:** Change to `sort:created-asc`. Remove `timelineItems` from this query -- timelines are fetched separately. Add `id` (node ID) to fetched fields.

**Timeline query (new):** Standalone query per open PR:
```graphql
query ($nodeId: ID!, $cursor: String) {
  node(id: $nodeId) {
    ... on PullRequest {
      title
      state
      isDraft
      timelineItems(
        first: 100
        after: $cursor
        itemTypes: [REVIEW_REQUESTED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT]
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ... }
      }
    }
  }
}
```

This also returns mutable PR fields (`title`, `state`, `isDraft`) for update.

## Window State Machine (Ingestion-Time)

Runs when processing new timeline events for a PR. Looks up the last `reviews` row for that PR to determine current state.

| Current state | Event | Action |
|---|---|---|
| No open window | `ReviewRequestedEvent` for team member | Insert review row with `requested_at`, add reviewer to `review_requested_reviewers` |
| No open window | `PullRequestReview` or `IssueComment` | Ignore |
| Open window (null `completed_at`) | `ReviewRequestedEvent` | Ignore |
| Open window | `PullRequestReview` from different team member (not PR author) | Set `completed_at`, `responded_by` |
| Open window | `IssueComment` from different team member (not PR author) | Set `completed_at`, `responded_by` |
| Open window | Event from PR author or non-team member | Ignore |

"Different team member" means: in `TEAM_MEMBERS` and not the PR author.

## Read Path

**Waiting for review (home page):**
```sql
SELECT r.*, p.title, p.url, p.author, p.number, p.repo
FROM reviews r
JOIN pull_requests p ON r.repo = p.repo AND r.pr_number = p.number
WHERE r.completed_at IS NULL AND p.state = 'OPEN'
```
Join `review_requested_reviewers` to get reviewer names. Group by reviewer in application code.

**Response times (analytics page):**
```sql
SELECT r.*, p.author, p.number, p.title, p.url, p.repo
FROM reviews r
JOIN pull_requests p ON r.repo = p.repo AND r.pr_number = p.number
WHERE r.completed_at IS NOT NULL
  AND r.requested_at >= ?  -- LOOKBACK_DAYS cutoff
```
Compute `businessHoursElapsed()` and stats in application code, same as today.

**Kept in application code:** `businessHoursElapsed()`, `computeStats()`, `groupWaitingByReviewer()`, `computeWeeklyTrend()`, `computeReviewerDetails()`.

**Removed:** `extractReviewWindows()` generator, `cache.ts`, `CachedPullRequest` type.

## Module Structure

### New files

- **`db.ts`** -- SQLite setup, schema creation, query helpers (insert PR, insert review, get open PRs, get reviews, cursor read/write).
- **`sync.ts`** -- Orchestrates initial load and incremental refresh. Replaces refresh logic in `serve.tsx`.
- **`ingest.ts`** -- Window state machine. Takes raw timeline events for a PR, queries current state from DB, inserts/updates review rows.

### Modified files

- **`github.ts`** -- Split into two query types: PR search (no timeline) and timeline fetch (by node ID). Remove `fetchPullRequestsByNumber`. Add `node_id` to PR fields/parsing.
- **`serve.tsx`** -- Replace cache loading with DB queries. Replace `backgroundRefresh()` with call to `sync.ts`. Keep SWR cooldown.
- **`web-data.ts`** -- Change input types from `ReviewWindow` to DB row types. Same transformations.
- **`metrics.ts`** -- Remove `extractReviewWindows()`. Keep or relocate business hours imports.

### Removed files

- **`cache.ts`**

### Unchanged files

- **`business-hours.ts`**, **`config.ts`**, **`components/*`**

## Comparison with Current Approach

| Aspect | Current | New |
|---|---|---|
| Storage | Web Cache API, single JSON blob | SQLite, normalized tables |
| Incremental PR fetch | Re-fetches all open PRs every refresh | Resumes from cursor, only new PRs |
| Timeline refresh | Full 100-item fetch per PR, every time | Resumes from cursor, only new events |
| Window computation | On every request (generator) | At ingestion, stored in DB |
| Read path | Parse blob, filter, generator, stats | SQL query, stats |
| Data durability | Runtime-dependent | SQLite file, Turso-migrateable |

**Pros:** Refresh cost proportional to new activity, not total open PRs. Structured storage. Clean Turso migration path. Minimal request-time work.

**Cons:** More complex initial implementation. Per-PR timeline queries on refresh (more HTTP round trips, but each is smaller).
