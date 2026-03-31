# Fresh Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `serve` subcommand that starts a Fresh 2.0 web server with two pages: PRs waiting for review (grouped by reviewer) and review response times (with drill-down and weekly trend).

**Architecture:** Fresh 2.0 with programmatic routes via `app.route()` — no Vite, no file-based routing, no client JS. Pages are fully server-rendered using Preact JSX. SWR strategy reads cache.json on each request and triggers background GitHub fetches on a 5-minute cooldown. CSS served from `static/styles.css` via Fresh's `staticFiles()` middleware.

**Tech Stack:** Fresh 2.0 (`@fresh/core`), Preact (JSX SSR), Deno

---

### Task 1: Add Fresh dependencies and JSX configuration

**Files:**
- Modify: `deno.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update deno.json with Fresh dependencies and compiler options**

```json
{
  "imports": {
    "@std/assert": "jsr:@std/assert@^1",
    "@std/cli": "jsr:@std/cli@^1",
    "@std/dotenv": "jsr:@std/dotenv@^0",
    "@std/fmt": "jsr:@std/fmt@^1",
    "@std/testing": "jsr:@std/testing@^1",
    "zod": "jsr:@zod/zod@^4",
    "fresh": "jsr:@fresh/core@^2.2.2",
    "preact": "npm:preact@^10.27.2"
  },
  "nodeModulesDir": "manual",
  "tasks": {
    "start": "deno run --allow-read=.env,cache.json --allow-write=cache.json --allow-net=api.github.com main.ts",
    "serve": "deno run --allow-read --allow-write=cache.json --allow-net --allow-env main.ts serve",
    "test": "deno test --allow-read --allow-write"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "preact",
    "jsxPrecompileSkipElements": [
      "a", "img", "source", "body", "html", "head",
      "title", "meta", "script", "link", "style", "base"
    ]
  }
}
```

- [ ] **Step 2: Update .gitignore**

Add `node_modules/` to `.gitignore`:

```
.DS_Store
.env
cache.json
node_modules/
```

- [ ] **Step 3: Install dependencies**

Run: `deno install`
Expected: node_modules/ created with preact, Fresh dependencies cached

- [ ] **Step 4: Verify the existing CLI still works**

Run: `deno task start --cached`
Expected: CLI runs normally, no type errors

- [ ] **Step 5: Commit**

```bash
git add deno.json .gitignore
git commit -m "feat: add Fresh and Preact dependencies for web dashboard"
```

---

### Task 2: Make cache I/O async

**Files:**
- Modify: `cache.ts`
- Modify: `cache_test.ts`
- Modify: `main.ts`

- [ ] **Step 1: Update cache_test.ts to use async loadCache and saveCache**

Replace the test file with async versions. Key changes: all `loadCache`/`saveCache` calls become `await`, test functions become `async`, temp file setup uses async Deno APIs.

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
  it("returns empty map for nonexistent file", async () => {
    const cache = await loadCache("/tmp/nonexistent-review-cache.json");
    assertEquals(cache.size, 0);
  });

  it("returns empty map for malformed JSON", async () => {
    const path = await Deno.makeTempFile();
    await Deno.writeTextFile(path, "not valid json {{{");
    const cache = await loadCache(path);
    assertEquals(cache.size, 0);
    await Deno.remove(path);
  });

  it("loads valid cache and keys by repo#number", async () => {
    const path = await Deno.makeTempFile();
    const data = [makeCachedPR("mpdx-react", 42)];
    await Deno.writeTextFile(path, JSON.stringify(data));

    const cache = await loadCache(path);

    assertEquals(cache.size, 1);
    assertEquals(cache.has("mpdx-react#42"), true);
    assertEquals(cache.get("mpdx-react#42")!.title, "Test PR #42");
    await Deno.remove(path);
  });
});

describe("saveCache", () => {
  it("round-trips through loadCache", async () => {
    const path = await Deno.makeTempFile();
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    original.set(
      "staff_accounting_app#10",
      makeCachedPR("staff_accounting_app", 10),
    );

    await saveCache(path, original);
    const loaded = await loadCache(path);

    assertEquals(loaded.size, 2);
    assertEquals(loaded.get("mpdx-react#42")!.number, 42);
    assertEquals(loaded.get("staff_accounting_app#10")!.number, 10);
    await Deno.remove(path);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test cache_test.ts`
Expected: FAIL — `loadCache` and `saveCache` are not async yet

- [ ] **Step 3: Make loadCache and saveCache async in cache.ts**

```typescript
import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export async function loadCache(
  path: string,
): Promise<Map<string, CachedPullRequest>> {
  try {
    const json = await Deno.readTextFile(path);
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

export async function saveCache(
  path: string,
  cache: Map<string, CachedPullRequest>,
): Promise<void> {
  const pullRequests = Array.from(cache.values());
  await Deno.writeTextFile(path, JSON.stringify(pullRequests));
}
```

- [ ] **Step 4: Run cache tests to verify they pass**

Run: `deno task test cache_test.ts`
Expected: PASS

- [ ] **Step 5: Update main.ts to await loadCache and saveCache**

Change line 24 from:
```typescript
const cache = loadCache(CACHE_PATH);
```
to:
```typescript
const cache = await loadCache(CACHE_PATH);
```

Change line 117 from:
```typescript
  saveCache(CACHE_PATH, cache);
```
to:
```typescript
  await saveCache(CACHE_PATH, cache);
```

- [ ] **Step 6: Run all tests**

Run: `deno task test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add cache.ts cache_test.ts main.ts
git commit -m "refactor: make loadCache and saveCache async"
```

---

### Task 3: Add requestedReviewers to ReviewWindow

**Files:**
- Modify: `metrics.ts`
- Modify: `metrics_test.ts`

- [ ] **Step 1: Write test for requestedReviewers on closed window**

Add to the `extractReviewWindows` describe block in `metrics_test.ts`:

```typescript
  it("closed window includes requestedReviewers", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
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
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 1);
    assertEquals(windows[0].requestedReviewers, ["canac", "dr-bizz"]);
  });

  it("open window includes requestedReviewers", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "kegrimes" },
        },
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:30:00Z",
          requestedReviewer: { login: "wjames111" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].requestedReviewers, ["kegrimes", "wjames111"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test metrics_test.ts`
Expected: FAIL — `requestedReviewers` property does not exist

- [ ] **Step 3: Add requestedReviewers to ReviewWindow and update generator**

In `metrics.ts`, add `requestedReviewers` to the interface:

```typescript
export interface ReviewWindow {
  pr: { number: number; title: string; url: string; author: string };
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  requestedReviewers: string[];
  businessHours: number;
}
```

In the `extractReviewWindows` generator, add tracking for requested reviewers. Replace the inner loop section:

```typescript
    let openWindowStart: Temporal.Instant | null = null;
    let windowReviewers: string[] = [];

    for (const item of sortedItems) {
      if (item.__typename === "ReviewRequestedEvent") {
        const requestedLogin = item.requestedReviewer?.login;
        if (!requestedLogin || !TEAM_MEMBER_SET.has(requestedLogin)) {
          continue;
        }
        if (openWindowStart === null) {
          openWindowStart = Temporal.Instant.from(item.createdAt);
        }
        if (!windowReviewers.includes(requestedLogin)) {
          windowReviewers.push(requestedLogin);
        }
        continue;
      }

      if (
        item.__typename === "PullRequestReview" ||
        item.__typename === "IssueComment"
      ) {
        if (openWindowStart === null) {
          continue;
        }

        const responderLogin = item.author?.login ?? "";

        if (
          responderLogin === prAuthor || !TEAM_MEMBER_SET.has(responderLogin)
        ) {
          continue;
        }

        const respondedAt = Temporal.Instant.from(item.createdAt);
        yield {
          pr: prInfo,
          requestedAt: openWindowStart,
          respondedAt,
          respondedBy: responderLogin,
          requestedReviewers: windowReviewers,
          businessHours: businessHoursElapsed(openWindowStart, respondedAt),
        };

        openWindowStart = null;
        windowReviewers = [];
      }
    }

    if (openWindowStart !== null && pullRequest.state === "OPEN") {
      const nowInstant = Temporal.Now.instant();
      yield {
        pr: prInfo,
        requestedAt: openWindowStart,
        respondedAt: null,
        respondedBy: null,
        requestedReviewers: windowReviewers,
        businessHours: businessHoursElapsed(openWindowStart, nowInstant),
      };
    }
```

- [ ] **Step 4: Run all tests**

Run: `deno task test`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add metrics.ts metrics_test.ts
git commit -m "feat: add requestedReviewers to ReviewWindow"
```

---

### Task 4: Create web data transformation module

**Files:**
- Create: `web-data.ts`
- Create: `web-data_test.ts`

- [ ] **Step 1: Write tests for all three functions**

Create `web-data_test.ts`:

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import type { ReviewWindow } from "./metrics.ts";

function makeWindow(overrides: Partial<ReviewWindow> = {}): ReviewWindow {
  return {
    pr: { number: 1, title: "Test PR", url: "https://github.com/CruGlobal/repo/pull/1", author: "author" },
    requestedAt: Temporal.Instant.from("2026-03-30T14:00:00Z"),
    respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
    respondedBy: "canac",
    requestedReviewers: ["canac"],
    businessHours: 1,
    ...overrides,
  };
}

describe("groupWaitingByReviewer", () => {
  it("groups open windows by each requested reviewer", () => {
    const windows = [
      makeWindow({
        respondedAt: null,
        respondedBy: null,
        requestedReviewers: ["canac", "dr-bizz"],
        businessHours: 5,
      }),
      makeWindow({
        pr: { number: 2, title: "PR 2", url: "https://github.com/CruGlobal/repo/pull/2", author: "author" },
        respondedAt: null,
        respondedBy: null,
        requestedReviewers: ["canac"],
        businessHours: 3,
      }),
    ];

    const grouped = groupWaitingByReviewer(windows);

    assertEquals(grouped.get("canac")!.length, 2);
    assertEquals(grouped.get("dr-bizz")!.length, 1);
    // Sorted by business hours descending
    assertEquals(grouped.get("canac")![0].businessHours, 5);
    assertEquals(grouped.get("canac")![1].businessHours, 3);
  });

  it("skips closed windows", () => {
    const windows = [
      makeWindow({ respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z") }),
    ];

    const grouped = groupWaitingByReviewer(windows);
    assertEquals(grouped.size, 0);
  });
});

describe("computeWeeklyTrend", () => {
  it("buckets closed windows by ISO week of response", () => {
    const windows = [
      // Week of 2026-03-23 (Monday)
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-23T15:00:00Z"),
        businessHours: 2,
      }),
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-25T15:00:00Z"),
        businessHours: 4,
      }),
      // Week of 2026-03-30 (Monday)
      makeWindow({
        respondedAt: Temporal.Instant.from("2026-03-30T15:00:00Z"),
        businessHours: 6,
      }),
    ];

    const trend = computeWeeklyTrend(windows);

    assertEquals(trend.length, 2);
    assertEquals(trend[0].weekStart, "2026-03-23");
    assertEquals(trend[0].median, 3); // median of [2, 4]
    assertEquals(trend[1].weekStart, "2026-03-30");
    assertEquals(trend[1].median, 6); // median of [6]
  });

  it("skips open windows", () => {
    const windows = [
      makeWindow({ respondedAt: null, respondedBy: null }),
    ];

    const trend = computeWeeklyTrend(windows);
    assertEquals(trend.length, 0);
  });
});

describe("computeReviewerDetails", () => {
  it("returns per-reviewer stats and individual windows sorted by hours descending", () => {
    const windows = [
      makeWindow({ respondedBy: "canac", businessHours: 2 }),
      makeWindow({ respondedBy: "canac", businessHours: 8 }),
      makeWindow({ respondedBy: "dr-bizz", businessHours: 5 }),
    ];

    const details = computeReviewerDetails(windows);

    assertEquals(details.length, 2);
    // Sorted by median descending: canac median=5, dr-bizz median=5
    // canac has windows sorted: [8, 2]
    const canacDetail = details.find((detail) => detail.reviewer === "canac")!;
    assertEquals(canacDetail.stats.count, 2);
    assertEquals(canacDetail.windows[0].businessHours, 8);
    assertEquals(canacDetail.windows[1].businessHours, 2);
  });

  it("skips open windows", () => {
    const windows = [
      makeWindow({ respondedAt: null, respondedBy: null }),
    ];

    const details = computeReviewerDetails(windows);
    assertEquals(details.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno task test web-data_test.ts`
Expected: FAIL — module `./web-data.ts` not found

- [ ] **Step 3: Implement web-data.ts**

Create `web-data.ts`:

```typescript
import { computeStats, type ReviewWindow, type Stats } from "./metrics.ts";
import { BUSINESS_HOURS } from "./config.ts";

export function groupWaitingByReviewer(
  windows: ReviewWindow[],
): Map<string, ReviewWindow[]> {
  const byReviewer = new Map<string, ReviewWindow[]>();

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

export function computeWeeklyTrend(windows: ReviewWindow[]): WeekBucket[] {
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
  windows: ReviewWindow[];
}

export function computeReviewerDetails(
  windows: ReviewWindow[],
): ReviewerDetail[] {
  const byReviewer = new Map<string, ReviewWindow[]>();

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

- [ ] **Step 4: Run tests**

Run: `deno task test web-data_test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `deno task test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add web-data.ts web-data_test.ts
git commit -m "feat: add web data transformation module"
```

---

### Task 5: Create CSS stylesheet and static directory

**Files:**
- Create: `static/styles.css`

- [ ] **Step 1: Create static directory and stylesheet**

Create `static/styles.css`:

```css
:root {
  --bg-body: #1a1a2e;
  --bg-card: #2a2a3a;
  --bg-nav: #2a2a4a;
  --bg-header: #222240;
  --text-primary: #e0e0e0;
  --text-secondary: #aaa;
  --text-muted: #888;
  --text-dimmed: #666;
  --border-subtle: #333;
  --color-ok: #22c55e;
  --color-warning: #eab308;
  --color-overdue: #ef4444;
  --color-link: #93c5fd;
  --color-accent: #7c6ff7;
}

*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
}

body {
  background: var(--bg-body);
  color: var(--text-primary);
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1.5;
}

a {
  color: var(--color-link);
  text-decoration: none;
}

/* Navigation */
.nav {
  display: flex;
  border-bottom: 1px solid var(--border-subtle);
}

.nav a {
  padding: 12px 24px;
  color: var(--text-muted);
  font-weight: 500;
}

.nav a:hover {
  color: var(--text-primary);
}

.nav a.active {
  background: var(--bg-nav);
  border-bottom: 2px solid var(--color-accent);
  color: #fff;
  font-weight: 600;
}

/* Content */
.content {
  padding: 24px;
  max-width: 960px;
}

.last-updated {
  color: var(--text-muted);
  font-size: 13px;
  margin-bottom: 20px;
}

/* Status colors */
.status-ok { color: var(--color-ok); }
.status-warning { color: var(--color-warning); }
.status-overdue { color: var(--color-overdue); }

.border-ok { border-left-color: var(--color-ok); }
.border-warning { border-left-color: var(--color-warning); }
.border-overdue { border-left-color: var(--color-overdue); }

/* Reviewer groups (waiting page) */
.reviewer-group {
  margin-bottom: 28px;
}

.reviewer-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  color: #fff;
}

.avatar-sm {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
  color: #fff;
}

.reviewer-name {
  font-weight: 600;
  font-size: 16px;
}

.badge {
  background: var(--border-subtle);
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* PR cards */
.pr-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-left: 40px;
}

.pr-card {
  background: var(--bg-card);
  border-left: 3px solid;
  border-radius: 4px;
  padding: 12px 16px;
}

.pr-card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.pr-link {
  font-weight: 500;
}

.pr-title {
  color: #ccc;
  margin-left: 8px;
}

.pr-hours {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  margin-left: 16px;
}

.pr-meta {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 4px;
}

.no-prs {
  color: var(--text-dimmed);
  font-style: italic;
  font-size: 14px;
  margin-left: 40px;
}

.empty-state {
  color: var(--text-muted);
  font-size: 16px;
  padding: 40px 0;
}

/* Stats cards (response times page) */
.stats-cards {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
}

.stat-card {
  background: var(--bg-card);
  border-radius: 8px;
  padding: 20px 28px;
  flex: 1;
  text-align: center;
}

.stat-label {
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
}

/* Section titles */
.section-title {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 16px;
}

/* Weekly bar chart */
.chart-container {
  background: var(--bg-card);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 32px;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  height: 120px;
  border-bottom: 1px solid #444;
  padding-bottom: 8px;
}

.bar {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}

.bar-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.bar-fill {
  width: 100%;
  min-height: 4px;
  border-radius: 4px 4px 0 0;
}

.bar-fill.bg-ok { background: var(--color-ok); }
.bar-fill.bg-warning { background: var(--color-warning); }
.bar-fill.bg-overdue { background: var(--color-overdue); }

.chart-labels {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.chart-label {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
}

/* Reviewer table (response times page) */
.reviewer-table {
  background: var(--bg-card);
  border-radius: 8px;
  overflow: hidden;
}

.table-header {
  display: grid;
  grid-template-columns: 1fr 80px 80px 60px;
  padding: 12px 16px;
  background: var(--bg-header);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
}

.table-header > *:not(:first-child) {
  text-align: right;
}

/* Drill-down via details/summary */
details.reviewer-row {
  border-bottom: 1px solid var(--border-subtle);
}

details.reviewer-row:last-child {
  border-bottom: none;
}

details.reviewer-row > summary {
  display: grid;
  grid-template-columns: 1fr 80px 80px 60px;
  padding: 14px 16px;
  align-items: center;
  cursor: pointer;
  list-style: none;
}

details.reviewer-row > summary::-webkit-details-marker {
  display: none;
}

details.reviewer-row > summary > *:not(:first-child) {
  text-align: right;
}

details.reviewer-row > summary::after {
  content: "";
  display: none;
}

.reviewer-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expand-indicator {
  color: var(--text-dimmed);
  margin-left: auto;
  transition: transform 0.15s;
  font-size: 12px;
}

details[open] .expand-indicator {
  transform: rotate(90deg);
}

.drill-down {
  background: #1e1e36;
  padding: 12px 16px 12px 56px;
}

.drill-down-header {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.drill-down-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drill-down-item {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}

.drill-down-title {
  color: var(--text-secondary);
}
```

- [ ] **Step 2: Commit**

```bash
git add static/styles.css
git commit -m "feat: add dark theme CSS for web dashboard"
```

---

### Task 6: Create Preact page components

**Files:**
- Create: `components/Layout.tsx`
- Create: `components/WaitingPage.tsx`
- Create: `components/ResponseTimesPage.tsx`

- [ ] **Step 1: Create components/Layout.tsx**

```tsx
import type { ComponentChildren } from "preact";

export function Layout(
  { activeTab, children, lastUpdated }: {
    activeTab: "waiting" | "response-times";
    children: ComponentChildren;
    lastUpdated: Date | null;
  },
) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Review Dashboard</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <nav class="nav">
          <a href="/" class={activeTab === "waiting" ? "active" : ""}>
            Waiting for Review
          </a>
          <a
            href="/response-times"
            class={activeTab === "response-times" ? "active" : ""}
          >
            Response Times
          </a>
        </nav>
        <div class="content">
          <div class="last-updated">
            Last updated: {formatRelativeTime(lastUpdated)}
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}

function formatRelativeTime(date: Date | null): string {
  if (!date) {
    return "never";
  }
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
}
```

- [ ] **Step 2: Create components/WaitingPage.tsx**

```tsx
import { Layout } from "./Layout.tsx";
import type { ReviewWindow } from "../metrics.ts";
import { TEAM_MEMBERS, THRESHOLDS } from "../config.ts";
import { BUSINESS_HOURS } from "../config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

interface WaitingPageData {
  waitingByReviewer: Map<string, ReviewWindow[]>;
  lastUpdated: Date | null;
}

function statusClass(hours: number): string {
  if (hours < THRESHOLDS.warning) {
    return "ok";
  }
  return hours < THRESHOLDS.overdue ? "warning" : "overdue";
}

function formatHours(hours: number): string {
  if (hours < HOURS_PER_DAY) {
    return `${hours.toFixed(1)}h`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  const remainder = hours % HOURS_PER_DAY;
  return `${days}d ${remainder.toFixed(1)}h`;
}

function repoFromUrl(url: string): string {
  const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
  return match?.[1] ?? "";
}

const AVATAR_COLORS = ["#7c6ff7", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"];

function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash + char.charCodeAt(0)) % AVATAR_COLORS.length;
  }
  return AVATAR_COLORS[hash];
}

export function WaitingPage({ data }: { data: WaitingPageData }) {
  return (
    <Layout activeTab="waiting" lastUpdated={data.lastUpdated}>
      {TEAM_MEMBERS.map((reviewer) => {
        const windows = data.waitingByReviewer.get(reviewer) ?? [];
        return (
          <div class="reviewer-group" key={reviewer}>
            <div class="reviewer-header">
              <div
                class="avatar"
                style={`background: ${avatarColor(reviewer)}`}
              >
                {reviewer[0].toUpperCase()}
              </div>
              <span class="reviewer-name">{reviewer}</span>
              <span class="badge">
                {windows.length} PR{windows.length !== 1 ? "s" : ""}
              </span>
            </div>
            {windows.length === 0
              ? <div class="no-prs">No PRs waiting</div>
              : (
                <div class="pr-list">
                  {windows.map((window) => (
                    <div
                      class={`pr-card border-${statusClass(window.businessHours)}`}
                      key={window.pr.url}
                    >
                      <div class="pr-card-row">
                        <div>
                          <a class="pr-link" href={window.pr.url}>
                            {repoFromUrl(window.pr.url)} #{window.pr.number}
                          </a>
                          <span class="pr-title">{window.pr.title}</span>
                        </div>
                        <span
                          class={`pr-hours status-${statusClass(window.businessHours)}`}
                        >
                          {formatHours(window.businessHours)}
                        </span>
                      </div>
                      <div class="pr-meta">
                        opened by {window.pr.author}
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        );
      })}
    </Layout>
  );
}
```

- [ ] **Step 3: Create components/ResponseTimesPage.tsx**

```tsx
import { Layout } from "./Layout.tsx";
import type { ReviewWindow, Stats } from "../metrics.ts";
import type { ReviewerDetail, WeekBucket } from "../web-data.ts";
import { BUSINESS_HOURS, THRESHOLDS } from "../config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

interface ResponseTimesData {
  overall: Stats;
  trend: WeekBucket[];
  reviewerDetails: ReviewerDetail[];
  lastUpdated: Date | null;
}

function statusClass(hours: number): string {
  if (hours < THRESHOLDS.warning) {
    return "ok";
  }
  return hours < THRESHOLDS.overdue ? "warning" : "overdue";
}

function formatHours(hours: number): string {
  if (hours < HOURS_PER_DAY) {
    return `${hours.toFixed(1)}h`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  const remainder = hours % HOURS_PER_DAY;
  return `${days}d ${remainder.toFixed(1)}h`;
}

function repoFromUrl(url: string): string {
  const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
  return match?.[1] ?? "";
}

const AVATAR_COLORS = ["#7c6ff7", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"];

function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash + char.charCodeAt(0)) % AVATAR_COLORS.length;
  }
  return AVATAR_COLORS[hash];
}

function formatWeekLabel(isoDate: string): string {
  const date = Temporal.PlainDate.from(isoDate);
  return date.toLocaleString("en-US", { month: "short", day: "numeric" });
}

function OverallStats({ overall }: { overall: Stats }) {
  if (overall.count === 0) {
    return <div class="empty-state">No review data in this period.</div>;
  }
  return (
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-label">Median</div>
        <div class={`stat-value status-${statusClass(overall.median)}`}>
          {formatHours(overall.median)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">P90</div>
        <div class={`stat-value status-${statusClass(overall.p90)}`}>
          {formatHours(overall.p90)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Reviews</div>
        <div class="stat-value" style="color: var(--color-link)">
          {overall.count}
        </div>
      </div>
    </div>
  );
}

function WeeklyChart({ trend }: { trend: WeekBucket[] }) {
  if (trend.length === 0) {
    return null;
  }
  const maxMedian = Math.max(...trend.map((bucket) => bucket.median));
  return (
    <div>
      <div class="section-title">Weekly Trend (Median Response Time)</div>
      <div class="chart-container">
        <div class="chart">
          {trend.map((bucket) => {
            const heightPercent = maxMedian > 0
              ? (bucket.median / maxMedian) * 100
              : 0;
            return (
              <div class="bar" key={bucket.weekStart}>
                <span class="bar-label">{formatHours(bucket.median)}</span>
                <div
                  class={`bar-fill bg-${statusClass(bucket.median)}`}
                  style={`height: ${heightPercent}%`}
                />
              </div>
            );
          })}
        </div>
        <div class="chart-labels">
          {trend.map((bucket) => (
            <div class="chart-label" key={bucket.weekStart}>
              {formatWeekLabel(bucket.weekStart)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewerTable(
  { reviewerDetails }: { reviewerDetails: ReviewerDetail[] },
) {
  if (reviewerDetails.length === 0) {
    return null;
  }
  return (
    <div>
      <div class="section-title">Per Reviewer</div>
      <div class="reviewer-table">
        <div class="table-header">
          <div>Reviewer</div>
          <div>Median</div>
          <div>P90</div>
          <div>Count</div>
        </div>
        {reviewerDetails.map((detail) => (
          <ReviewerRow detail={detail} key={detail.reviewer} />
        ))}
      </div>
    </div>
  );
}

function ReviewerRow({ detail }: { detail: ReviewerDetail }) {
  return (
    <details class="reviewer-row">
      <summary>
        <div class="reviewer-cell">
          <div
            class="avatar-sm"
            style={`background: ${avatarColor(detail.reviewer)}`}
          >
            {detail.reviewer[0].toUpperCase()}
          </div>
          <span>{detail.reviewer}</span>
          <span class="expand-indicator">&#9654;</span>
        </div>
        <div class={`status-${statusClass(detail.stats.median)}`}>
          {formatHours(detail.stats.median)}
        </div>
        <div class={`status-${statusClass(detail.stats.p90)}`}>
          {formatHours(detail.stats.p90)}
        </div>
        <div style="color: var(--text-secondary)">{detail.stats.count}</div>
      </summary>
      <div class="drill-down">
        <div class="drill-down-header">
          Recent reviews by {detail.reviewer}:
        </div>
        <div class="drill-down-list">
          {detail.windows.map((window) => (
            <div class="drill-down-item" key={window.pr.url}>
              <span>
                <a href={window.pr.url}>
                  {repoFromUrl(window.pr.url)} #{window.pr.number}
                </a>
                {" "}
                <span class="drill-down-title">{window.pr.title}</span>
              </span>
              <span class={`status-${statusClass(window.businessHours)}`}>
                {formatHours(window.businessHours)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function ResponseTimesPage({ data }: { data: ResponseTimesData }) {
  return (
    <Layout activeTab="response-times" lastUpdated={data.lastUpdated}>
      <OverallStats overall={data.overall} />
      <WeeklyChart trend={data.trend} />
      <ReviewerTable reviewerDetails={data.reviewerDetails} />
    </Layout>
  );
}
```

- [ ] **Step 4: Verify components type-check**

Run: `deno check components/Layout.tsx components/WaitingPage.tsx components/ResponseTimesPage.tsx`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add components/
git commit -m "feat: add Preact page components for web dashboard"
```

---

### Task 7: Create serve.ts with Fresh App and SWR

**Files:**
- Create: `serve.ts`

- [ ] **Step 1: Create serve.ts**

```typescript
import { App, page, staticFiles } from "fresh";
import { load } from "@std/dotenv";
import { CACHE_PATH, LOOKBACK_DAYS, REPOS } from "./config.ts";
import {
  cacheKey,
  type CachedPullRequest,
  loadCache,
  saveCache,
} from "./cache.ts";
import { fetchPullRequests, fetchPullRequestsByNumber } from "./github.ts";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import { WaitingPage } from "./components/WaitingPage.tsx";
import { ResponseTimesPage } from "./components/ResponseTimesPage.tsx";

const SWR_COOLDOWN_MS = 5 * 60 * 1000;
let lastFetchedAt = 0;

async function getToken(): Promise<string> {
  const env = await load();
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN must be set in .env file");
  }
  return token;
}

async function backgroundRefresh(): Promise<void> {
  try {
    const token = await getToken();
    const cache = await loadCache(CACHE_PATH);

    if (cache.size === 0) {
      const freshPRs = await fetchPullRequests(token);
      for (const pullRequest of freshPRs) {
        cache.set(
          cacheKey(pullRequest.repo, pullRequest.number),
          pullRequest,
        );
      }
    } else {
      const previouslyOpen = new Map(
        Array.from(cache).filter(([, pullRequest]) =>
          pullRequest.state === "OPEN"
        ),
      );

      const freshOpen = await fetchPullRequests(token, { states: ["OPEN"] });
      const freshOpenKeys = new Set<string>();
      for (const pullRequest of freshOpen) {
        const key = cacheKey(pullRequest.repo, pullRequest.number);
        freshOpenKeys.add(key);
        cache.set(key, pullRequest);
      }

      const missingByRepo = new Map<string, number[]>();
      for (const [key, pullRequest] of previouslyOpen) {
        if (!freshOpenKeys.has(key)) {
          const numbers = missingByRepo.get(pullRequest.repo) ?? [];
          numbers.push(pullRequest.number);
          missingByRepo.set(pullRequest.repo, numbers);
        }
      }

      if (missingByRepo.size > 0) {
        const fetches = Array.from(
          missingByRepo,
          ([repo, numbers]) => fetchPullRequestsByNumber(token, repo, numbers),
        );
        const missingPRs = (await Promise.all(fetches)).flat();
        for (const pullRequest of missingPRs) {
          cache.set(
            cacheKey(pullRequest.repo, pullRequest.number),
            pullRequest,
          );
        }
      }
    }

    await saveCache(CACHE_PATH, cache);
    console.log("Background refresh complete");
  } catch (error) {
    console.error("Background refresh failed:", error);
  }
}

function maybeRefreshInBackground(): void {
  if (Date.now() - lastFetchedAt > SWR_COOLDOWN_MS) {
    lastFetchedAt = Date.now();
    backgroundRefresh();
  }
}

async function loadWindowsAndMeta(): Promise<{
  allWindows: ReviewWindow[];
  lastUpdated: Date | null;
}> {
  const cache = await loadCache(CACHE_PATH);
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });
  const pullRequests = Array.from(cache.values()).filter((pullRequest) => {
    const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
    return Temporal.Instant.compare(prCreatedAt, since) >= 0;
  });

  const allWindows = extractReviewWindows(pullRequests).toArray();
  const cacheStats = await Deno.stat(CACHE_PATH).catch(() => null);

  return {
    allWindows,
    lastUpdated: cacheStats?.mtime ?? null,
  };
}

export async function startServer(): Promise<void> {
  const app = new App();
  app.use(staticFiles());

  app.route("/", {
    handler: {
      async GET() {
        const { allWindows, lastUpdated } = await loadWindowsAndMeta();
        maybeRefreshInBackground();
        return page({
          waitingByReviewer: groupWaitingByReviewer(allWindows),
          lastUpdated,
        });
      },
    },
    component: WaitingPage,
  });

  app.route("/response-times", {
    handler: {
      async GET() {
        const { allWindows, lastUpdated } = await loadWindowsAndMeta();
        const closedWindows = allWindows.filter((window) =>
          window.respondedAt !== null
        );
        maybeRefreshInBackground();
        return page({
          overall: computeStats(
            closedWindows.map((window) => window.businessHours),
          ),
          trend: computeWeeklyTrend(allWindows),
          reviewerDetails: computeReviewerDetails(allWindows),
          lastUpdated,
        });
      },
    },
    component: ResponseTimesPage,
  });

  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;

  console.log(
    `Starting review dashboard on http://localhost:${port ?? 8000}`,
  );
  await app.listen({ port });
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `deno check serve.ts`
Expected: No type errors (or only warnings about Fresh internals)

- [ ] **Step 3: Commit**

```bash
git add serve.ts
git commit -m "feat: add Fresh server with SWR background refresh"
```

---

### Task 8: Wire up main.ts serve subcommand

**Files:**
- Modify: `main.ts`

- [ ] **Step 1: Add serve subcommand to main.ts**

Wrap the existing CLI logic so that `deno task serve` (which runs `main.ts serve`) starts the web server instead. Add the subcommand check after arg parsing and env loading:

Replace the top of `main.ts` (lines 1–18) with:

```typescript
import { load } from "@std/dotenv";
import { Spinner } from "@std/cli/unstable-spinner";
import { parseArgs } from "@std/cli/parse-args";
import { CACHE_PATH, LOOKBACK_DAYS, REPOS } from "./config.ts";
import { fetchPullRequests, fetchPullRequestsByNumber } from "./github.ts";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import { printStats, printWaiting } from "./output.ts";
import { cacheKey, loadCache, saveCache } from "./cache.ts";

const args = parseArgs(Deno.args, { boolean: ["cached"] });

// Serve subcommand: start the web dashboard
if (args._[0] === "serve") {
  const { startServer } = await import("./serve.ts");
  await startServer();
  Deno.exit(0);
}

const env = await load();
const token = env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: GITHUB_TOKEN must be set in .env file.");
  Deno.exit(1);
}
```

The rest of `main.ts` stays the same (from `// Step 1: Load cache` onward).

- [ ] **Step 2: Verify CLI still works**

Run: `deno task start --cached`
Expected: CLI runs as before

- [ ] **Step 3: Commit**

```bash
git add main.ts deno.json
git commit -m "feat: add serve subcommand to start web dashboard"
```

---

### Task 9: Smoke test

- [ ] **Step 1: Start the server**

Run: `deno task serve`
Expected: Server starts, prints `Starting review dashboard on http://localhost:8000`

- [ ] **Step 2: Verify the waiting page**

Open `http://localhost:8000` in Chrome.
Expected: Dark-themed page with "Waiting for Review" tab active, reviewer groups shown. If cache.json exists with data, PRs are displayed grouped by reviewer with color-coded borders. If no cache, page renders with empty state.

- [ ] **Step 3: Verify the response times page**

Open `http://localhost:8000/response-times` in Chrome.
Expected: Stats cards at top, weekly trend bar chart, per-reviewer table with expandable `<details>` rows. Tab navigation works between pages.

- [ ] **Step 4: Verify SWR refresh**

Check server console output after loading a page.
Expected: If cache is older than 5 minutes (or no previous fetch), see "Background refresh complete" in console. Reload the page to see updated data.

- [ ] **Step 5: Verify CSS is served (no inline styles)**

View page source in Chrome DevTools.
Expected: `<link rel="stylesheet" href="/styles.css" />` in `<head>`, no inline `style` attributes on structural elements.

- [ ] **Step 6: Fix any issues found during smoke test**

Address any rendering, routing, or data issues. Common things to check:
- Verify `staticFiles()` serves `/styles.css` from the `static/` directory
- If Fresh adds unwanted `<script>` tags, check if there's a config option to disable client JS
- Verify `<details>`/`<summary>` drill-down works without JS
- Verify color coding matches thresholds (green <4h, yellow 4-8h, red 8h+)
