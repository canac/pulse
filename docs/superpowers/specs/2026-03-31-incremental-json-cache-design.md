# Incremental JSON Cache — Design Spec

## Context

The CLI currently fetches all PRs from the last 30 days on every run — about 200
PRs across 5 paginated GraphQL requests. Most of those PRs are closed/merged and
will never change. This spec adds a local JSON file cache so that subsequent runs
only fetch what's changed: currently-open PRs and recently-closed ones.

## Overview

A `cache.json` file in the project directory stores the full `PullRequest` blobs
(with timeline items) from previous runs. On each invocation the CLI loads the
cache, fetches only the delta from GitHub, merges it, writes the cache back, then
runs the existing metrics pipeline against the cached data.

**First run** does a full fetch (identical to today). **Subsequent runs** only
re-fetch open PRs plus any PRs that transitioned from open to closed/merged since
the last run. **`--cached` flag** skips all network calls and uses the cache
as-is (offline mode).

## Data Model

### Cache File

Path: `./cache.json` (added to `.gitignore`).

The file is a JSON array of `CachedPullRequest` objects:

```typescript
interface CachedPullRequest {
  repo: string;          // e.g. "mpdx-react"
  number: number;
  title: string;
  url: string;
  createdAt: string;
  mergedAt: string | null;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  author: { login: string } | null;
  timelineItems: {
    nodes: TimelineItem[];
  };
}
```

This is the existing `PullRequest` Zod type plus a `repo` field. The cache key
for deduplication is `"repo#number"` (e.g. `"mpdx-react#1669"`), reconstructed
from the `repo` and `number` fields on load.

### Why JSON, Not SQLite

The dataset is small (~200 PRs, ~1-2 MB), always loaded entirely into memory for
stats aggregation, and has no need for indexed queries. A JSON file is simpler —
no schema, no dependencies, no migrations.

## Orchestration

Each CLI invocation follows this sequence:

```
1. Load cache from ./cache.json → Map<string, CachedPullRequest>
2. If --cached: skip to step 5
3. If cache is empty (first run):
     Full fetch (states: OPEN, MERGED, CLOSED) → merge all into cache
   Else (incremental):
     a. Collect previouslyOpen = cache entries with state "OPEN"
     b. Fetch states: [OPEN] from API → freshOpen
     c. Merge freshOpen into cache (upserts by repo#number)
     d. missing = previouslyOpen keys not present in freshOpen
     e. Fetch each missing PR by number → merge into cache
4. Save cache to ./cache.json
5. Filter cache values to last 30 days
6. Feed filtered PRs into extractReviewWindows → computeStats → print
```

### Step 3e Detail: Fetching Missing PRs

PRs in `previouslyOpen` that are absent from `freshOpen` have transitioned to
merged/closed since the last run. We fetch each by number using a GraphQL query
with `repository.pullRequest(number: N)`. Multiple missing PRs in the same repo
are batched into a single request using GraphQL aliases:

```graphql
query($owner: String!, $name: String!) {
  pr123: pullRequest(number: 123) { ...PullRequestFields }
  pr456: pullRequest(number: 456) { ...PullRequestFields }
}
```

This keeps the request count to at most one per repo that had closures (typically
0-3 extra requests per run).

## Changes to Existing Files

### `github.ts`

- Remove the Web Cache API caching code (`caches.open`, `CACHE_NAME`,
  `CACHE_MAX_AGE_MS`, cache read/write in `graphql()`).
- Remove the `useCache` parameter from `graphql()`.
- Add a `states` parameter to `fetchPullRequests`:
  ```typescript
  export async function fetchPullRequests(
    token: string,
    options?: {
      states?: ("OPEN" | "MERGED" | "CLOSED")[];
      onRepoComplete?: () => void;
    },
  ): Promise<PullRequest[]>
  ```
  Default `states` to `["OPEN", "MERGED", "CLOSED"]`. Pass into the GraphQL
  query as a variable instead of hardcoding.
- Add a `fetchPullRequestsByNumber` function:
  ```typescript
  export async function fetchPullRequestsByNumber(
    token: string,
    repo: string,
    prNumbers: number[],
  ): Promise<PullRequest[]>
  ```
  Uses GraphQL aliases to batch multiple PR-by-number lookups into one request
  per repo. Returns the same `PullRequest` shape.

### `cache.ts` (new)

```typescript
export interface CachedPullRequest extends PullRequest {
  repo: string;
}

export function loadCache(path: string): Map<string, CachedPullRequest>;
export function saveCache(path: string, cache: Map<string, CachedPullRequest>): void;
export function cacheKey(repo: string, number: number): string;
```

- `loadCache`: reads and parses the JSON file. Returns empty map if file doesn't
  exist or is malformed (treats it as a cold start).
- `saveCache`: serializes map values to a JSON array and writes to disk.
- `cacheKey`: returns `"repo#number"`.

### `main.ts`

- Replace the current fetch-and-collect logic with the orchestration described
  above.
- `--cached` flag now means "offline mode" (skip network, read cache only)
  instead of controlling the Web Cache API.
- Spinner messages update to reflect what's happening: "Fetching all PRs..."
  on first run, "Refreshing open PRs..." on incremental, skipped on `--cached`.
- After merging, filter cache values to PRs within `LOOKBACK_DAYS` before
  feeding into the pipeline.

### `config.ts`

- Add `CACHE_PATH = "./cache.json"`.

### `.gitignore`

- Add `cache.json`.

### `deno.json`

- Add `--allow-write` to the `start` task.

## What Doesn't Change

- `business-hours.ts` — no changes.
- `metrics.ts` — `extractReviewWindows` and `computeStats` consume the same
  `PullRequest` type (the `repo` field is ignored, passed through in
  `ReviewWindow.pr`). The `ReviewWindow.pr` interface gains a `repo` field.
- `output.ts` — no changes (already uses `pr.url` for display).
- All existing tests remain valid.

## Testing

### `cache_test.ts` (new)

- `loadCache` with nonexistent file returns empty map
- `loadCache` with malformed JSON returns empty map
- `loadCache` with valid JSON returns correct map keyed by repo#number
- `saveCache` writes valid JSON that round-trips through `loadCache`
- `cacheKey` returns expected format

### Manual Verification

1. Delete `cache.json`, run CLI — full fetch, cache file created
2. Run CLI again — incremental fetch (fewer requests, faster)
3. Run with `--cached` — instant, no network
4. Close a PR on GitHub, run CLI — PR state updates in cache
5. Verify stats match between full fetch and cached results
