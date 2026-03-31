# PR Review Metrics Tracker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Deno CLI tool that fetches PR timeline data from GitHub
GraphQL, computes review response times in business hours, and prints a colored
summary.

**Architecture:** Generator-based pipeline — async generator yields PRs from
GitHub API, sync generator extracts review windows, then stats are aggregated
and printed. Business hours calculator uses Temporal API for timezone-aware
weekday-only counting.

**Tech Stack:** Deno, TypeScript, Zod, Temporal API, `@std/fmt/colors`,
`@std/testing`, `@std/assert`

---

## File Structure

| File                     | Responsibility                                                                  |
| ------------------------ | ------------------------------------------------------------------------------- |
| `deno.json`              | Import map, tasks                                                               |
| `config.ts`              | Hardcoded team members, repos, business hours constants, review time thresholds |
| `github.ts`              | GraphQL client, Zod schemas, async generator yielding PRs                       |
| `business-hours.ts`      | Calculate elapsed business hours between two instants                           |
| `business-hours_test.ts` | Tests for business hours edge cases                                             |
| `metrics.ts`             | Extract review windows (generator), compute median/P90                          |
| `metrics_test.ts`        | Tests for window extraction and stat computation                                |
| `output.ts`              | Format and print colored CLI output                                             |
| `main.ts`                | Entry point — wire the pipeline together                                        |

---

### Task 1: Project Setup

**Files:**

- Create: `deno.json`
- Create: `config.ts`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "zod": "npm:zod@^3.24",
    "@std/fmt/colors": "jsr:@std/fmt@^1/colors",
    "@std/testing/bdd": "jsr:@std/testing@^1/bdd",
    "@std/assert": "jsr:@std/assert@^1"
  },
  "tasks": {
    "start": "deno run --allow-net --allow-env main.ts",
    "test": "deno test"
  }
}
```

- [ ] **Step 2: Create `config.ts`**

```typescript
export const TEAM_MEMBERS = [
  // TODO: fill in actual GitHub usernames before first run
  "alice",
  "bob",
  "carol",
] as const;

export const REPOS = [
  // TODO: fill in actual repos before first run
  { owner: "my-org", name: "repo-one" },
  { owner: "my-org", name: "repo-two" },
] as const;

export const BUSINESS_HOURS = {
  start: 10,
  end: 16,
  tz: "America/New_York",
} as const;

export const LOOKBACK_DAYS = 30;

/** Review wait time thresholds in business hours. */
export const THRESHOLDS = {
  /** 4+ business hours — needs attention */
  warning: 4,
  /** 6+ business hours — overdue */
  overdue: 6,
} as const;
```

- [ ] **Step 3: Verify setup**

Run: `deno check config.ts` Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add deno.json config.ts
git commit -m "feat: project setup with deno.json and config"
```

---

### Task 2: Business Hours Calculator — Tests

**Files:**

- Create: `business-hours.ts` (stub)
- Create: `business-hours_test.ts`

- [ ] **Step 1: Create stub `business-hours.ts`**

```typescript
export function businessHoursElapsed(
  _start: Temporal.Instant,
  _end: Temporal.Instant,
): number {
  throw new Error("Not implemented");
}
```

- [ ] **Step 2: Write tests in `business-hours_test.ts`**

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { businessHoursElapsed } from "./business-hours.ts";

function instant(iso: string): Temporal.Instant {
  return Temporal.Instant.from(iso);
}

describe("businessHoursElapsed", () => {
  it("same business day", () => {
    // Monday March 30 2026, 11am → 2pm ET (EDT = UTC-4)
    const result = businessHoursElapsed(
      instant("2026-03-30T15:00:00Z"), // 11am ET
      instant("2026-03-30T18:00:00Z"), // 2pm ET
    );
    assertEquals(result, 3);
  });

  it("across a single night", () => {
    // Monday 3pm ET → Tuesday 11am ET = 1h Monday + 1h Tuesday = 2h
    const result = businessHoursElapsed(
      instant("2026-03-30T19:00:00Z"), // Monday 3pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 2);
  });

  it("across a weekend", () => {
    // Friday 2pm ET → Monday 11am ET = 2h Friday + 1h Monday = 3h
    const result = businessHoursElapsed(
      instant("2026-03-27T18:00:00Z"), // Friday 2pm ET
      instant("2026-03-30T15:00:00Z"), // Monday 11am ET
    );
    assertEquals(result, 3);
  });

  it("start before business hours", () => {
    // Monday 8am ET → Monday 2pm ET = clamped to 10am, so 4h
    const result = businessHoursElapsed(
      instant("2026-03-30T12:00:00Z"), // 8am ET
      instant("2026-03-30T18:00:00Z"), // 2pm ET
    );
    assertEquals(result, 4);
  });

  it("start after business hours", () => {
    // Monday 5pm ET → Tuesday 11am ET = clamped to Tue 10am, so 1h
    const result = businessHoursElapsed(
      instant("2026-03-30T21:00:00Z"), // Monday 5pm ET
      instant("2026-03-31T15:00:00Z"), // Tuesday 11am ET
    );
    assertEquals(result, 1);
  });

  it("start on weekend", () => {
    // Saturday 12pm ET → Monday 2pm ET = clamped to Mon 10am, so 4h
    const result = businessHoursElapsed(
      instant("2026-03-28T16:00:00Z"), // Saturday 12pm ET
      instant("2026-03-30T18:00:00Z"), // Monday 2pm ET
    );
    assertEquals(result, 4);
  });

  it("end after business hours clamps to close", () => {
    // Monday 10am ET → Monday 7pm ET = clamped to 4pm, so 6h
    const result = businessHoursElapsed(
      instant("2026-03-30T14:00:00Z"), // Monday 10am ET
      instant("2026-03-30T23:00:00Z"), // Monday 7pm ET
    );
    assertEquals(result, 6);
  });

  it("multi-day span", () => {
    // Monday 10am ET → Wednesday 4pm ET = 6 + 6 + 6 = 18h
    const result = businessHoursElapsed(
      instant("2026-03-30T14:00:00Z"), // Monday 10am ET
      instant("2026-04-01T20:00:00Z"), // Wednesday 4pm ET
    );
    assertEquals(result, 18);
  });

  it("both on weekend returns zero", () => {
    const result = businessHoursElapsed(
      instant("2026-03-28T14:00:00Z"), // Saturday
      instant("2026-03-29T14:00:00Z"), // Sunday
    );
    assertEquals(result, 0);
  });

  it("end before start returns zero", () => {
    const result = businessHoursElapsed(
      instant("2026-03-30T18:00:00Z"), // Monday 2pm ET
      instant("2026-03-30T15:00:00Z"), // Monday 11am ET
    );
    assertEquals(result, 0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `deno test business-hours_test.ts` Expected: All tests FAIL with "Not
implemented".

- [ ] **Step 4: Commit**

```bash
git add business-hours.ts business-hours_test.ts
git commit -m "test: add business hours calculator tests (red)"
```

---

### Task 3: Business Hours Calculator — Implementation

**Files:**

- Modify: `business-hours.ts`

- [ ] **Step 1: Implement `businessHoursElapsed`**

Replace the contents of `business-hours.ts` with:

```typescript
import { BUSINESS_HOURS } from "./config.ts";

const { start: BH_START, end: BH_END, tz: TZ } = BUSINESS_HOURS;
const HOURS_PER_DAY = BH_END - BH_START;

function toZoned(instant: Temporal.Instant): Temporal.ZonedDateTime {
  return instant.toZonedDateTimeISO(TZ);
}

function isWeekday(zdt: Temporal.ZonedDateTime): boolean {
  return zdt.dayOfWeek >= 1 && zdt.dayOfWeek <= 5;
}

/** Clamp a time forward to the next business window opening. */
function clampForward(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  // Advance past weekends
  while (!isWeekday(zdt)) {
    zdt = zdt.add({ days: 1 }).withPlainTime({ hour: BH_START });
  }
  // Before open → snap to open
  if (zdt.hour < BH_START) {
    return zdt.withPlainTime({ hour: BH_START });
  }
  // After close → next business day open
  if (zdt.hour >= BH_END) {
    zdt = zdt.add({ days: 1 }).withPlainTime({ hour: BH_START });
    while (!isWeekday(zdt)) {
      zdt = zdt.add({ days: 1 });
    }
    return zdt;
  }
  return zdt;
}

/** Clamp a time backward to the previous business window close. */
function clampBackward(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  while (!isWeekday(zdt)) {
    zdt = zdt.subtract({ days: 1 }).withPlainTime({ hour: BH_END });
  }
  if (zdt.hour >= BH_END) {
    return zdt.withPlainTime({ hour: BH_END });
  }
  if (zdt.hour < BH_START) {
    zdt = zdt.subtract({ days: 1 }).withPlainTime({ hour: BH_END });
    while (!isWeekday(zdt)) {
      zdt = zdt.subtract({ days: 1 });
    }
    return zdt;
  }
  return zdt;
}

/**
 * Calculate elapsed business hours between two instants.
 * Only counts weekdays 10am–4pm Eastern (6h per day).
 * Returns 0 if end <= start after clamping.
 */
export function businessHoursElapsed(
  start: Temporal.Instant,
  end: Temporal.Instant,
): number {
  let s = clampForward(toZoned(start));
  let e = clampBackward(toZoned(end));

  if (Temporal.ZonedDateTime.compare(e, s) <= 0) {
    return 0;
  }

  // Same calendar day
  if (
    s.year === e.year && s.month === e.month && s.day === e.day
  ) {
    return (e.hour + e.minute / 60) - (s.hour + s.minute / 60);
  }

  // Partial hours on start day (from s to close)
  let total = BH_END - (s.hour + s.minute / 60);

  // Advance to next day
  s = s.add({ days: 1 }).withPlainTime({ hour: BH_START });

  // Count full business days in between
  while (
    s.year < e.year ||
    (s.year === e.year && s.month < e.month) ||
    (s.year === e.year && s.month === e.month && s.day < e.day)
  ) {
    if (isWeekday(s)) {
      total += HOURS_PER_DAY;
    }
    s = s.add({ days: 1 });
  }

  // Partial hours on end day (from open to e)
  total += (e.hour + e.minute / 60) - BH_START;

  return total;
}
```

- [ ] **Step 2: Run tests**

Run: `deno test business-hours_test.ts` Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add business-hours.ts
git commit -m "feat: implement business hours calculator"
```

---

### Task 4: GitHub API — Zod Schemas and Client

**Files:**

- Create: `github.ts`

- [ ] **Step 1: Create `github.ts` with Zod schemas and async generator**

```typescript
import { z } from "zod";
import { LOOKBACK_DAYS, REPOS } from "./config.ts";

// --- Zod Schemas ---

const ActorSchema = z.object({
  login: z.string(),
}).nullable();

const ReviewRequestedEventSchema = z.object({
  __typename: z.literal("ReviewRequestedEvent"),
  createdAt: z.string(),
  requestedReviewer: z
    .object({ login: z.string() })
    .nullable(),
});

const PullRequestReviewSchema = z.object({
  __typename: z.literal("PullRequestReview"),
  createdAt: z.string(),
  author: ActorSchema,
});

const IssueCommentSchema = z.object({
  __typename: z.literal("IssueComment"),
  createdAt: z.string(),
  author: ActorSchema,
});

const TimelineItemSchema = z.discriminatedUnion("__typename", [
  ReviewRequestedEventSchema,
  PullRequestReviewSchema,
  IssueCommentSchema,
]);

const PullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  author: ActorSchema,
  timelineItems: z.object({
    nodes: z.array(TimelineItemSchema),
  }),
});

const QueryResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(PullRequestSchema),
      }),
    }),
  }),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// --- GraphQL Query ---

const QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: 100
      after: $cursor
      states: [OPEN, MERGED, CLOSED]
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url createdAt mergedAt isDraft state
        author { login }
        timelineItems(first: 100, itemTypes: [
          REVIEW_REQUESTED_EVENT
          PULL_REQUEST_REVIEW
          ISSUE_COMMENT
        ]) {
          nodes {
            __typename
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { ... on User { login } }
            }
            ... on PullRequestReview {
              createdAt
              author { login }
            }
            ... on IssueComment {
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
}
`;

// --- API Client ---

async function graphql(
  token: string,
  variables: Record<string, unknown>,
): Promise<z.infer<typeof QueryResponseSchema>> {
  const resp = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API error ${resp.status}: ${text}`);
  }

  const json = await resp.json();

  if (json.errors) {
    throw new Error(
      `GitHub GraphQL errors: ${JSON.stringify(json.errors)}`,
    );
  }

  return QueryResponseSchema.parse(json);
}

// --- Async Generator ---

export async function* fetchPullRequests(
  token: string,
): AsyncGenerator<PullRequest> {
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });
  const sinceMs = since.epochMilliseconds;

  for (const repo of REPOS) {
    let cursor: string | null = null;

    while (true) {
      const result = await graphql(token, {
        owner: repo.owner,
        name: repo.name,
        cursor,
      });

      const { nodes, pageInfo } = result.data.repository.pullRequests;
      let reachedOldPRs = false;

      for (const pr of nodes) {
        // Stop if we've gone past the lookback window
        if (new Date(pr.createdAt).getTime() < sinceMs) {
          reachedOldPRs = true;
          break;
        }

        // Skip drafts
        if (pr.isDraft) continue;

        yield pr;
      }

      if (reachedOldPRs || !pageInfo.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `deno check github.ts` Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add github.ts
git commit -m "feat: GitHub GraphQL client with Zod schemas and async generator"
```

---

### Task 5: Metrics — Tests

**Files:**

- Create: `metrics.ts` (stub)
- Create: `metrics_test.ts`

- [ ] **Step 1: Create stub `metrics.ts`**

```typescript
import type { PullRequest } from "./github.ts";

export interface ReviewWindow {
  pr: { number: number; title: string; url: string; author: string };
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  businessHours: number;
}

export function* extractReviewWindows(
  _prs: Iterable<PullRequest>,
): Generator<ReviewWindow> {
  throw new Error("Not implemented");
}

export interface Stats {
  median: number;
  p90: number;
  count: number;
}

export function computeStats(_values: number[]): Stats {
  throw new Error("Not implemented");
}
```

- [ ] **Step 2: Write tests in `metrics_test.ts`**

```typescript
import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import type { PullRequest } from "./github.ts";

function makePR(overrides: {
  number?: number;
  author?: string;
  timelineItems: PullRequest["timelineItems"]["nodes"];
}): PullRequest {
  return {
    number: overrides.number ?? 1,
    title: "Test PR",
    url: "https://github.com/org/repo/pull/1",
    createdAt: "2026-03-30T14:00:00Z",
    mergedAt: null,
    isDraft: false,
    state: "OPEN",
    author: { login: overrides.author ?? "author" },
    timelineItems: { nodes: overrides.timelineItems },
  };
}

function collect(prs: PullRequest[]): ReviewWindow[] {
  return [...extractReviewWindows(prs)];
}

describe("extractReviewWindows", () => {
  it("single request and review yields one closed window", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z", // Mon 11am ET
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "PullRequestReview",
            createdAt: "2026-03-30T17:00:00Z", // Mon 1pm ET
            author: { login: "alice" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedBy, "alice");
    assertEquals(windows[0].respondedAt !== null, true);
  });

  it("multiple review requests before response are de-duplicated", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:01:00Z",
            requestedReviewer: { login: "bob" },
          },
          {
            __typename: "PullRequestReview",
            createdAt: "2026-03-30T17:00:00Z",
            author: { login: "bob" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    // Window starts at first request
    assertEquals(
      windows[0].requestedAt.toString(),
      "2026-03-30T15:00:00Z",
    );
  });

  it("two review cycles yield two windows", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "PullRequestReview",
            createdAt: "2026-03-30T17:00:00Z",
            author: { login: "alice" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-31T15:00:00Z",
            requestedReviewer: { login: "bob" },
          },
          {
            __typename: "PullRequestReview",
            createdAt: "2026-03-31T17:00:00Z",
            author: { login: "bob" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 2);
    assertEquals(windows[0].respondedBy, "alice");
    assertEquals(windows[1].respondedBy, "bob");
  });

  it("comment from team member counts as review", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "IssueComment",
            createdAt: "2026-03-30T16:00:00Z",
            author: { login: "bob" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedBy, "bob");
  });

  it("comment from PR author does not close window", () => {
    const windows = collect([
      makePR({
        author: "author",
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "IssueComment",
            createdAt: "2026-03-30T16:00:00Z",
            author: { login: "author" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
  });

  it("comment from non-team-member does not close window", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
          {
            __typename: "IssueComment",
            createdAt: "2026-03-30T16:00:00Z",
            author: { login: "outsider" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
  });

  it("open PR with pending request yields open window", () => {
    const windows = collect([
      makePR({
        timelineItems: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-30T15:00:00Z",
            requestedReviewer: { login: "alice" },
          },
        ],
      }),
    ]);

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].respondedBy, null);
  });
});

describe("computeStats", () => {
  it("computes median and P90 for odd-length array", () => {
    const stats = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assertEquals(stats.median, 5.5);
    assertEquals(stats.p90, 9);
    assertEquals(stats.count, 10);
  });

  it("single value", () => {
    const stats = computeStats([3]);
    assertEquals(stats.median, 3);
    assertEquals(stats.p90, 3);
    assertEquals(stats.count, 1);
  });

  it("empty array returns zeros", () => {
    const stats = computeStats([]);
    assertEquals(stats.median, 0);
    assertEquals(stats.p90, 0);
    assertEquals(stats.count, 0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `deno test metrics_test.ts` Expected: All tests FAIL with "Not
implemented".

- [ ] **Step 4: Commit**

```bash
git add metrics.ts metrics_test.ts
git commit -m "test: add metrics extraction and stats tests (red)"
```

---

### Task 6: Metrics — Implementation

**Files:**

- Modify: `metrics.ts`

- [ ] **Step 1: Implement `metrics.ts`**

Replace the contents of `metrics.ts` with:

```typescript
import type { PullRequest, TimelineItem } from "./github.ts";
import { TEAM_MEMBERS } from "./config.ts";
import { businessHoursElapsed } from "./business-hours.ts";

export interface ReviewWindow {
  pr: { number: number; title: string; url: string; author: string };
  requestedAt: Temporal.Instant;
  respondedAt: Temporal.Instant | null;
  respondedBy: string | null;
  businessHours: number;
}

export interface Stats {
  median: number;
  p90: number;
  count: number;
}

const teamSet = new Set<string>(TEAM_MEMBERS);

function isTeamReview(
  item: TimelineItem,
  prAuthor: string,
): item is TimelineItem & { author: { login: string } } {
  if (item.__typename === "ReviewRequestedEvent") return false;
  const login = item.author?.login;
  if (!login) return false;
  if (login === prAuthor) return false;
  return teamSet.has(login);
}

export function* extractReviewWindows(
  prs: Iterable<PullRequest>,
): Generator<ReviewWindow> {
  for (const pr of prs) {
    const prAuthor = pr.author?.login ?? "";
    const prMeta = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: prAuthor,
    };

    // Sort timeline items by createdAt
    const items = [...pr.timelineItems.nodes].sort(
      (a, b) =>
        Temporal.Instant.from(a.createdAt).epochMilliseconds -
        Temporal.Instant.from(b.createdAt).epochMilliseconds,
    );

    let windowStart: Temporal.Instant | null = null;

    for (const item of items) {
      if (
        item.__typename === "ReviewRequestedEvent" && windowStart === null
      ) {
        // Open a new window at the first review request
        windowStart = Temporal.Instant.from(item.createdAt);
      } else if (windowStart !== null && isTeamReview(item, prAuthor)) {
        // Close the window
        const respondedAt = Temporal.Instant.from(item.createdAt);
        yield {
          pr: prMeta,
          requestedAt: windowStart,
          respondedAt,
          respondedBy: item.author.login,
          businessHours: businessHoursElapsed(windowStart, respondedAt),
        };
        windowStart = null;
      }
    }

    // If there's an unclosed window, yield it as open (waiting)
    if (windowStart !== null) {
      const now = Temporal.Now.instant();
      yield {
        pr: prMeta,
        requestedAt: windowStart,
        respondedAt: null,
        respondedBy: null,
        businessHours: businessHoursElapsed(windowStart, now),
      };
    }
  }
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) return { median: 0, p90: 0, count: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;

  let median: number;
  if (n % 2 === 0) {
    median = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  } else {
    median = sorted[Math.floor(n / 2)];
  }

  const p90 = sorted[Math.min(Math.floor(n * 0.9), n - 1)];

  return { median, p90, count: n };
}
```

- [ ] **Step 2: Run tests**

Run: `deno test metrics_test.ts` Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add metrics.ts
git commit -m "feat: implement review window extraction and stats computation"
```

---

### Task 7: Output Formatting

**Files:**

- Create: `output.ts`

- [ ] **Step 1: Create `output.ts`**

```typescript
import { bold, green, red, yellow } from "@std/fmt/colors";
import type { ReviewWindow, Stats } from "./metrics.ts";
import { BUSINESS_HOURS, THRESHOLDS } from "./config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

function formatHours(h: number): string {
  if (h < HOURS_PER_DAY) {
    return `${h.toFixed(1)}h`;
  }
  const days = Math.floor(h / HOURS_PER_DAY);
  const rem = h % HOURS_PER_DAY;
  return `${days}d ${rem.toFixed(1)}h`;
}

function colorize(hours: number, text: string): string {
  if (hours < THRESHOLDS.warning) return green(text);
  if (hours < THRESHOLDS.overdue) return yellow(text);
  return red(text);
}

function urgencyEmoji(hours: number): string {
  if (hours < THRESHOLDS.warning) return "🟢";
  if (hours < THRESHOLDS.overdue) return "🟡";
  return "🔴";
}

export function printWaiting(windows: ReviewWindow[]): void {
  console.log(bold("\n📋 Waiting for Review\n"));

  const waiting = windows
    .filter((w) => w.respondedAt === null)
    .sort((a, b) => b.businessHours - a.businessHours);

  if (waiting.length === 0) {
    console.log("  No PRs waiting for review! 🎉\n");
    return;
  }

  for (const w of waiting) {
    const time = formatHours(w.businessHours);
    const emoji = urgencyEmoji(w.businessHours);
    const colored = colorize(w.businessHours, `${time} waiting`);
    console.log(`  ${emoji} ${w.pr.url} — "${w.pr.title}" (${colored})`);
    console.log(`     Opened by @${w.pr.author}`);
  }
  console.log();
}

export function printStats(
  overall: Stats,
  perReviewer: Map<string, Stats>,
): void {
  console.log(bold("📊 Review Response Times (Last 30 Days)\n"));

  if (overall.count === 0) {
    console.log("  No review data in this period.\n");
    return;
  }

  console.log(
    `  Overall: median ${formatHours(overall.median)}, P90 ${
      formatHours(overall.p90)
    } (${overall.count} reviews)`,
  );
  console.log();

  // Sort by median, slowest first
  const sorted = [...perReviewer.entries()].sort(
    (a, b) => b[1].median - a[1].median,
  );

  if (sorted.length > 0) {
    console.log("  Per reviewer (first responder):");
    for (const [reviewer, stats] of sorted) {
      const medianStr = colorize(
        stats.median,
        `median ${formatHours(stats.median)}`,
      );
      const p90Str = colorize(stats.p90, `P90 ${formatHours(stats.p90)}`);
      console.log(
        `    @${reviewer} — ${medianStr}, ${p90Str} (${stats.count} reviews)`,
      );
    }
  }
  console.log();
}
```

- [ ] **Step 2: Type-check**

Run: `deno check output.ts` Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add output.ts
git commit -m "feat: add colored CLI output formatting"
```

---

### Task 8: Main Entry Point

**Files:**

- Create: `main.ts`

- [ ] **Step 1: Create `main.ts`**

```typescript
import { fetchPullRequests } from "./github.ts";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import { printStats, printWaiting } from "./output.ts";

const token = Deno.env.get("GITHUB_TOKEN");
if (!token) {
  console.error("Error: GITHUB_TOKEN environment variable is required.");
  Deno.exit(1);
}

// Fetch all PRs via async generator, collect into array
const prs = [];
for await (const pr of fetchPullRequests(token)) {
  prs.push(pr);
}

// Extract review windows via sync generator, collect into array
const allWindows: ReviewWindow[] = [...extractReviewWindows(prs)];

// Split into closed (historical) and open (waiting)
const closed = allWindows.filter((w) => w.respondedAt !== null);
const closedHours = closed.map((w) => w.businessHours);

// Overall stats
const overall = computeStats(closedHours);

// Per-reviewer stats
const byReviewer = new Map<string, number[]>();
for (const w of closed) {
  if (w.respondedBy) {
    const arr = byReviewer.get(w.respondedBy) ?? [];
    arr.push(w.businessHours);
    byReviewer.set(w.respondedBy, arr);
  }
}

const perReviewerStats = new Map(
  [...byReviewer.entries()].map(([name, hours]) => [
    name,
    computeStats(hours),
  ]),
);

// Print output
printWaiting(allWindows);
printStats(overall, perReviewerStats);
```

- [ ] **Step 2: Type-check**

Run: `deno check main.ts` Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add main.ts
git commit -m "feat: add main entry point wiring the pipeline together"
```

---

### Task 9: Full Integration Test

- [ ] **Step 1: Run all unit tests**

Run: `deno test` Expected: All tests pass.

- [ ] **Step 2: Run the tool against real repos**

Run: `GITHUB_TOKEN=<token> deno run --allow-net --allow-env main.ts`

Expected: Colored output showing waiting PRs and historical stats. If no PRs are
found, the output should still print headers with "no data" messages.

- [ ] **Step 3: Update config with real values**

Edit `config.ts` to add actual team members and repos. Re-run to verify with
real data.

- [ ] **Step 4: Commit final config**

```bash
git add config.ts
git commit -m "chore: configure real team members and repos"
```
