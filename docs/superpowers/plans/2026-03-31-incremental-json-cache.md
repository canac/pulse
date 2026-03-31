# Incremental JSON Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local JSON file cache so subsequent CLI runs only fetch open/changed PRs from GitHub instead of the full 30-day history.

**Architecture:** A `cache.json` file stores full PR blobs. On first run, all PRs are fetched and cached. On subsequent runs, only open PRs are re-fetched; PRs that transitioned from open to closed/merged are fetched individually by number. `--cached` flag skips all network calls (offline mode).

**Tech Stack:** Deno, TypeScript, Zod (existing), `@std/cli` spinner (existing)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `config.ts` | Add `CACHE_PATH` constant |
| `cache.ts` | **New** — load/save JSON cache, `CachedPullRequest` type |
| `cache_test.ts` | **New** — tests for cache module |
| `github.ts` | Remove Web Cache API, add `states` param, add `fetchPullRequestsByNumber`, tag PRs with repo name |
| `main.ts` | New orchestration: load cache → incremental fetch → save → pipeline |
| `.gitignore` | Add `cache.json` |
| `deno.json` | Add `--allow-write` to start task |

---

### Task 1: Project Setup

**Files:**
- Modify: `config.ts`
- Modify: `.gitignore`
- Modify: `deno.json`

- [ ] **Step 1: Add `CACHE_PATH` to `config.ts`**

Add after the `THRESHOLDS` export:

```typescript
export const CACHE_PATH = "./cache.json";
```

- [ ] **Step 2: Add `cache.json` to `.gitignore`**

Append to `.gitignore`:

```
cache.json
```

- [ ] **Step 3: Add `--allow-write` to the start task in `deno.json`**

Change the `start` task from:

```json
"start": "deno run --allow-read --allow-net --allow-env main.ts"
```

to:

```json
"start": "deno run --allow-read --allow-write --allow-net --allow-env main.ts"
```

- [ ] **Step 4: Verify**

Run: `deno check config.ts`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add config.ts .gitignore deno.json
git commit -m "chore: add CACHE_PATH config, update gitignore and deno task"
```

---

### Task 2: Cache Module (TDD)

**Files:**
- Create: `cache.ts`
- Create: `cache_test.ts`

- [ ] **Step 1: Create stub `cache.ts`**

```typescript
import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

export function cacheKey(_repo: string, _number: number): string {
  throw new Error("Not implemented");
}

export function loadCache(_path: string): Map<string, CachedPullRequest> {
  throw new Error("Not implemented");
}

export function saveCache(
  _path: string,
  _cache: Map<string, CachedPullRequest>,
): void {
  throw new Error("Not implemented");
}
```

- [ ] **Step 2: Write tests in `cache_test.ts`**

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  type CachedPullRequest,
  cacheKey,
  loadCache,
  saveCache,
} from "./cache.ts";

function makeCachedPR(
  repo: string,
  number: number,
): CachedPullRequest {
  return {
    repo,
    number,
    title: `Test PR #${number}`,
    url: `https://github.com/CruGlobal/${repo}/pull/${number}`,
    createdAt: "2026-03-30T14:00:00Z",
    isDraft: false,
    state: "OPEN",
    author: { login: "someauthor" },
    timelineItems: { nodes: [] },
  };
}

describe("cacheKey", () => {
  it("formats as repo#number", () => {
    assertEquals(cacheKey("mpdx-react", 123), "mpdx-react#123");
  });
});

describe("loadCache", () => {
  it("returns empty map for nonexistent file", () => {
    const cache = loadCache("/tmp/nonexistent-review-cache.json");
    assertEquals(cache.size, 0);
  });

  it("returns empty map for malformed JSON", () => {
    const path = Deno.makeTempFileSync();
    Deno.writeTextFileSync(path, "not valid json {{{");
    const cache = loadCache(path);
    assertEquals(cache.size, 0);
    Deno.removeSync(path);
  });

  it("loads valid cache and keys by repo#number", () => {
    const path = Deno.makeTempFileSync();
    const data = [makeCachedPR("mpdx-react", 42)];
    Deno.writeTextFileSync(path, JSON.stringify(data));

    const cache = loadCache(path);

    assertEquals(cache.size, 1);
    assertEquals(cache.has("mpdx-react#42"), true);
    assertEquals(cache.get("mpdx-react#42")!.title, "Test PR #42");
    Deno.removeSync(path);
  });
});

describe("saveCache", () => {
  it("round-trips through loadCache", () => {
    const path = Deno.makeTempFileSync();
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    original.set(
      "staff_accounting_app#10",
      makeCachedPR("staff_accounting_app", 10),
    );

    saveCache(path, original);
    const loaded = loadCache(path);

    assertEquals(loaded.size, 2);
    assertEquals(loaded.get("mpdx-react#42")!.number, 42);
    assertEquals(loaded.get("staff_accounting_app#10")!.number, 10);
    Deno.removeSync(path);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `deno test cache_test.ts`
Expected: All tests FAIL with "Not implemented".

- [ ] **Step 4: Implement `cache.ts`**

Replace the contents of `cache.ts` with:

```typescript
import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function loadCache(path: string): Map<string, CachedPullRequest> {
  try {
    const json = Deno.readTextFileSync(path);
    const pullRequests: CachedPullRequest[] = JSON.parse(json);
    const cache = new Map<string, CachedPullRequest>();
    for (const pullRequest of pullRequests) {
      cache.set(cacheKey(pullRequest.repo, pullRequest.number), pullRequest);
    }
    return cache;
  } catch {
    return new Map();
  }
}

export function saveCache(
  path: string,
  cache: Map<string, CachedPullRequest>,
): void {
  const pullRequests = Array.from(cache.values());
  Deno.writeTextFileSync(path, JSON.stringify(pullRequests));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno test cache_test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add cache.ts cache_test.ts
git commit -m "feat: add JSON cache module with load/save/cacheKey"
```

---

### Task 3: Refactor `github.ts`

Remove the Web Cache API, make PR states configurable, add a function to fetch individual PRs by number, and tag all returned PRs with their repo name.

**Files:**
- Modify: `github.ts`

- [ ] **Step 1: Extract PR fields into a shared constant and update the list query**

Replace the `PULL_REQUESTS_QUERY` constant (lines 71–100) with two constants — a shared fragment string and the list query that uses a `$states` variable:

```typescript
const PR_FIELDS = `
  number title url createdAt isDraft state
  author { login }
  timelineItems(first: 100, itemTypes: [
    REVIEW_REQUESTED_EVENT
    PULL_REQUEST_REVIEW
    ISSUE_COMMENT
  ]) {
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
      ... on PullRequestReview { createdAt author { login } }
      ... on IssueComment { createdAt author { login } }
    }
  }
`;

const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 100
        after: $cursor
        states: $states
        orderBy: { field: CREATED_AT, direction: DESC }
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

- [ ] **Step 2: Remove Web Cache API code and simplify `graphql` helper**

Replace the entire GraphQL helper section (lines 102–165, from `const CACHE_NAME` through the closing brace of `graphql()`) with a generic request function that takes a query string parameter:

```typescript
async function graphqlRequest(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();

  if (json.errors?.length) {
    const errorMessages = json.errors
      .map((err: { message: string }) => err.message)
      .join("; ");
    throw new Error(`GitHub GraphQL errors: ${errorMessages}`);
  }

  return json;
}
```

- [ ] **Step 3: Update `fetchAllPagesForRepo` to accept `states` and tag PRs with repo**

Replace the entire `fetchAllPagesForRepo` function with:

```typescript
async function fetchAllPagesForRepo(
  token: string,
  repoName: string,
  since: Temporal.Instant,
  states: ("OPEN" | "MERGED" | "CLOSED")[],
): Promise<Array<PullRequest & { repo: string }>> {
  const pullRequests: Array<PullRequest & { repo: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const json = await graphqlRequest(token, PULL_REQUESTS_QUERY, {
      owner: GITHUB_ORG,
      name: repoName,
      cursor,
      states,
    });

    const result = QueryResponseSchema.parse(json);
    const pullRequestsPage = result.data.repository.pullRequests;
    const pageInfo = pullRequestsPage.pageInfo;

    let reachedOldPR = false;
    for (const pullRequest of pullRequestsPage.nodes) {
      if (pullRequest.isDraft) continue;

      const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
      if (Temporal.Instant.compare(prCreatedAt, since) < 0) {
        reachedOldPR = true;
        break;
      }

      pullRequests.push({ ...pullRequest, repo: repoName });
    }

    if (reachedOldPR || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return pullRequests;
}
```

- [ ] **Step 4: Update `fetchPullRequests` signature**

Replace the entire `fetchPullRequests` function with:

```typescript
const ALL_STATES: ("OPEN" | "MERGED" | "CLOSED")[] = [
  "OPEN",
  "MERGED",
  "CLOSED",
];

export async function fetchPullRequests(
  token: string,
  options: {
    states?: ("OPEN" | "MERGED" | "CLOSED")[];
    onRepoComplete?: () => void;
  } = {},
): Promise<Array<PullRequest & { repo: string }>> {
  const since = Temporal.Now.instant().subtract({ hours: LOOKBACK_DAYS * 24 });
  const states = options.states ?? ALL_STATES;

  const results = await Promise.all(
    REPOS.map(async (repoName) => {
      const pullRequests = await fetchAllPagesForRepo(
        token,
        repoName,
        since,
        states,
      );
      options.onRepoComplete?.();
      return pullRequests;
    }),
  );

  return results.flat();
}
```

- [ ] **Step 5: Add `fetchPullRequestsByNumber`**

Add this function after `fetchPullRequests`:

```typescript
export async function fetchPullRequestsByNumber(
  token: string,
  repo: string,
  prNumbers: number[],
): Promise<Array<PullRequest & { repo: string }>> {
  if (prNumbers.length === 0) return [];

  const prQueries = prNumbers
    .map((num) => `pr_${num}: pullRequest(number: ${num}) { ${PR_FIELDS} }`)
    .join("\n    ");

  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${prQueries}
      }
    }
  `;

  const json = await graphqlRequest(token, query, {
    owner: GITHUB_ORG,
    name: repo,
  });

  const data = json as { data?: { repository?: Record<string, unknown> } };
  const repository = data.data?.repository;
  if (!repository) return [];

  const pullRequests: Array<PullRequest & { repo: string }> = [];
  for (const num of prNumbers) {
    const prData = repository[`pr_${num}`];
    if (prData) {
      const parsed = PullRequestSchema.parse(prData);
      pullRequests.push({ ...parsed, repo });
    }
  }

  return pullRequests;
}
```

- [ ] **Step 6: Verify type-check and existing tests pass**

Run: `deno check github.ts && deno test`
Expected: Type-check passes. All existing tests in `business-hours_test.ts`, `metrics_test.ts`, and `cache_test.ts` still pass.

- [ ] **Step 7: Commit**

```bash
git add github.ts
git commit -m "feat: remove web cache, add states param and fetchPullRequestsByNumber"
```

---

### Task 4: Rewrite `main.ts` Orchestration

**Files:**
- Modify: `main.ts`

- [ ] **Step 1: Replace the entire contents of `main.ts`**

```typescript
import { load } from "@std/dotenv";
import { Spinner } from "@std/cli/unstable-spinner";
import { parseArgs } from "@std/cli/parse-args";
import { CACHE_PATH, LOOKBACK_DAYS, REPOS } from "./config.ts";
import {
  fetchPullRequests,
  fetchPullRequestsByNumber,
} from "./github.ts";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import { printStats, printWaiting } from "./output.ts";
import { cacheKey, loadCache, saveCache } from "./cache.ts";

const args = parseArgs(Deno.args, { boolean: ["cached"] });

const env = await load();
const token = env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: GITHUB_TOKEN must be set in .env file.");
  Deno.exit(1);
}

// Step 1: Load cache
const cache = loadCache(CACHE_PATH);

// Step 2: Fetch from GitHub (unless --cached)
if (!args.cached) {
  if (cache.size === 0) {
    // First run: full fetch of all PR states
    let reposCompleted = 0;
    const spinner = new Spinner({
      message: `Fetching all PRs... (0/${REPOS.length} repos)`,
    });
    spinner.start();

    const freshPRs = await fetchPullRequests(token, {
      onRepoComplete: () => {
        reposCompleted++;
        spinner.message =
          `Fetching all PRs... (${reposCompleted}/${REPOS.length} repos)`;
      },
    });

    spinner.stop();

    for (const pullRequest of freshPRs) {
      cache.set(cacheKey(pullRequest.repo, pullRequest.number), pullRequest);
    }
  } else {
    // Incremental: re-fetch open PRs, then check for newly closed ones
    const previouslyOpen = new Map(
      Array.from(cache).filter(([, pullRequest]) =>
        pullRequest.state === "OPEN"
      ),
    );

    let reposCompleted = 0;
    const spinner = new Spinner({
      message: `Refreshing open PRs... (0/${REPOS.length} repos)`,
    });
    spinner.start();

    const freshOpen = await fetchPullRequests(token, {
      states: ["OPEN"],
      onRepoComplete: () => {
        reposCompleted++;
        spinner.message =
          `Refreshing open PRs... (${reposCompleted}/${REPOS.length} repos)`;
      },
    });

    spinner.stop();

    // Merge fresh open PRs into cache
    const freshOpenKeys = new Set<string>();
    for (const pullRequest of freshOpen) {
      const key = cacheKey(pullRequest.repo, pullRequest.number);
      freshOpenKeys.add(key);
      cache.set(key, pullRequest);
    }

    // Find PRs that were open but are missing from fresh fetch (now closed/merged)
    const missingByRepo = new Map<string, number[]>();
    for (const [key, pullRequest] of previouslyOpen) {
      if (!freshOpenKeys.has(key)) {
        const numbers = missingByRepo.get(pullRequest.repo) ?? [];
        numbers.push(pullRequest.number);
        missingByRepo.set(pullRequest.repo, numbers);
      }
    }

    // Fetch missing PRs by number to get their final state
    if (missingByRepo.size > 0) {
      const missingSpinner = new Spinner({
        message: "Updating closed PRs...",
      });
      missingSpinner.start();

      const fetches = Array.from(
        missingByRepo,
        ([repo, numbers]) => fetchPullRequestsByNumber(token, repo, numbers),
      );
      const missingPRs = (await Promise.all(fetches)).flat();

      missingSpinner.stop();

      for (const pullRequest of missingPRs) {
        cache.set(
          cacheKey(pullRequest.repo, pullRequest.number),
          pullRequest,
        );
      }
    }
  }

  // Step 3: Save cache
  saveCache(CACHE_PATH, cache);
}

// Step 4: Filter to lookback window and run pipeline
const since = Temporal.Now.instant().subtract({ hours: LOOKBACK_DAYS * 24 });
const pullRequests = Array.from(cache.values()).filter((pullRequest) => {
  const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
  return Temporal.Instant.compare(prCreatedAt, since) >= 0;
});

const allWindows: ReviewWindow[] = extractReviewWindows(pullRequests).toArray();

const closedWindows = allWindows.filter((window) =>
  window.respondedAt !== null
);
const closedHours = closedWindows.map((window) => window.businessHours);

const overall = computeStats(closedHours);

const hoursByReviewer = new Map<string, number[]>();
for (const window of closedWindows) {
  if (window.respondedBy) {
    const existingHours = hoursByReviewer.get(window.respondedBy) ?? [];
    existingHours.push(window.businessHours);
    hoursByReviewer.set(window.respondedBy, existingHours);
  }
}

const perReviewerStats = new Map(
  Array.from(hoursByReviewer, ([name, hours]) => [name, computeStats(hours)]),
);

printWaiting(allWindows);
printStats(overall, perReviewerStats);
```

- [ ] **Step 2: Type-check**

Run: `deno check main.ts`
Expected: No errors.

- [ ] **Step 3: Run all tests**

Run: `deno test`
Expected: All tests pass (business-hours, metrics, cache).

- [ ] **Step 4: Commit**

```bash
git add main.ts
git commit -m "feat: rewrite main.ts with incremental JSON cache orchestration"
```

---

### Task 5: Integration Verification

- [ ] **Step 1: Delete any existing cache and run a full fetch**

Run: `rm -f cache.json && deno run --allow-read --allow-write --allow-net --allow-env main.ts`

Expected: Spinner shows "Fetching all PRs... (0/3 repos)" progressing to (3/3). Output shows waiting PRs and stats. `cache.json` is created.

- [ ] **Step 2: Run again (incremental)**

Run: `deno run --allow-read --allow-write --allow-net --allow-env main.ts`

Expected: Spinner shows "Refreshing open PRs..." instead of "Fetching all PRs...". Output matches step 1. Should be noticeably faster.

- [ ] **Step 3: Run with `--cached` (offline mode)**

Run: `deno run --allow-read --allow-write --allow-net --allow-env main.ts --cached`

Expected: No spinner (no network calls). Output matches steps 1 and 2. Instant.

- [ ] **Step 4: Verify stats match**

Compare the output of all three runs. The waiting PRs and review stats should be identical (or near-identical if a PR changed state between runs).

- [ ] **Step 5: Format**

Run: `deno fmt`
Expected: No changes (or minor formatting fixes).

- [ ] **Step 6: Final commit if needed**

```bash
git add -A && git commit -m "style: apply deno fmt"
```
