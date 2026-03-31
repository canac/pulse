# PR Review Metrics Tracker — Design Spec

## Context

Our team needs visibility into PR review responsiveness — both real-time ("what's waiting?") and historical ("how fast are we?"). Think of a fast food order board: you can see what's been waiting and for how long. This tool provides that for code reviews.

## Overview

A Deno CLI tool that fetches PR data from GitHub's GraphQL API, computes review response time metrics using business-hours-only counting, and prints a colored summary to the terminal.

**Run once, print stats, exit.** No subcommands, no server, no persistence.

## Architecture: Generator Pipeline

The data flows through a generator-based pipeline, keeping memory usage low and enabling composable processing:

```
fetchPRs(repo) ──yield──> PR with timeline items
       │
       ▼
extractReviewWindows(prs) ──yield──> ReviewWindow per PR
       │
       ▼
collect & compute stats ──> output
```

- **`github.ts`** exports an `async generator` that yields validated PR objects (with timeline items) across all repos, handling pagination internally. Consumers iterate with `for await`.
- **`metrics.ts`** exports a generator that consumes PR objects and yields `ReviewWindow` objects (both closed and open/waiting). The deduplication and window-opening/closing logic operates per-PR as items are yielded.
- **`main.ts`** collects the yielded review windows into arrays for final aggregation (medians/P90 require all data), then passes to output.

## Project Structure

```
review-dashboard/
├── deno.json                  # tasks, import map
├── main.ts                    # entry point — orchestrates the pipeline
├── config.ts                  # hardcoded team members, repos, constants
├── github.ts                  # GraphQL client, queries, Zod schemas
├── business-hours.ts          # business-hours elapsed time calculator
├── business-hours_test.ts     # tests for business hours logic
├── metrics.ts                 # review window extraction, median/P90 stats
├── metrics_test.ts            # tests for review window extraction & stats
└── output.ts                  # colored/emoji CLI output formatting
```

## Dependencies

- `zod` — validate GitHub API response shapes and derive TypeScript types
- `@std/fmt/colors` — ANSI terminal colors (Deno standard library)
- `@std/testing` — test runner (BDD-style with `describe`/`it`)
- `@std/assert` — test assertions (`assertEquals`, `assertAlmostEquals`, etc.)
- `Temporal` API — timezone-aware date/time (built into Deno, no import needed)

## Config (`config.ts`)

Exports hardcoded constants:

- `TEAM_MEMBERS: string[]` — GitHub usernames of team members
- `REPOS: { owner: string; name: string }[]` — repositories to track
- `BUSINESS_HOURS: { start: 10, end: 16, tz: "America/New_York" }` — 10am–4pm Eastern
- `LOOKBACK_DAYS: 30` — how far back to analyze

## Authentication

- Reads `GITHUB_TOKEN` environment variable (personal access token)
- Passed as `Authorization: bearer <token>` header
- Exits with a clear error message if not set

## GitHub API (`github.ts`)

### Query Strategy

One GraphQL query per repo fetching non-draft PRs with timeline items. Paginate PRs (100 per page) and stop when we hit PRs older than 30 days.

### Generator Interface

```typescript
async function* fetchPullRequests(
  repos: { owner: string; name: string }[],
  since: Temporal.Instant
): AsyncGenerator<PullRequest>
```

Iterates through all repos and pages, validates each response with Zod, filters out drafts and old PRs, and yields one `PullRequest` at a time. Pagination cursors are managed internally — callers just `for await (const pr of fetchPullRequests(repos, since))`.

### GraphQL Query

```graphql
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      first: 100,
      after: $cursor,
      states: [OPEN, MERGED, CLOSED],
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage, endCursor }
      nodes {
        number, title, url, createdAt, mergedAt, isDraft, state
        author { login }
        timelineItems(first: 100, itemTypes: [
          REVIEW_REQUESTED_EVENT,
          PULL_REQUEST_REVIEW,
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
```

### Zod Schemas

Define schemas for:
- Each timeline item type (`ReviewRequestedEvent`, `PullRequestReview`, `IssueComment`)
- The discriminated union of timeline items (using `__typename`)
- The PR node shape
- The full query response

These schemas validate the API response and provide TypeScript types via `z.infer<>`.

### Filtering

After fetching:
- Exclude draft PRs (`isDraft: true`)
- Exclude PRs created before the 30-day lookback window
- Stop paginating once all remaining PRs are older than the window

## Business Hours Calculator (`business-hours.ts`)

### Core Function

```typescript
function businessHoursElapsed(start: Temporal.Instant, end: Temporal.Instant): number
```

Returns elapsed hours counting only weekdays 10am–4pm Eastern (6 business hours per day).

### Algorithm

1. Convert `start` and `end` to `Temporal.ZonedDateTime` in `America/New_York`
2. Clamp `start` forward to next business window if outside hours:
   - Before 10am same day → 10am
   - After 4pm same day → 10am next business day
   - Weekend → 10am Monday
3. Clamp `end` similarly (but backward — if before 10am, use 4pm previous business day)
4. Walk day-by-day:
   - Same business day: simple subtraction in hours
   - Different days: partial hours on start day + (full business days between × 6) + partial hours on end day
5. Return total as a decimal number of hours

### Edge Cases

- Start and end on same business day
- Start on Friday evening, end on Monday morning
- Start/end outside business hours
- DST transitions (Temporal handles this)

## Metrics Computation (`metrics.ts`)

### Review Windows

#### Generator Interface

```typescript
function* extractReviewWindows(
  prs: Iterable<PullRequest>
): Generator<ReviewWindow>
```

Consumes PR objects and yields `ReviewWindow` objects. For each PR:

1. Sort timeline events by `createdAt`
2. A window **opens** at the earliest `ReviewRequestedEvent` in a cluster. Multiple review requests before any response are de-duplicated into one window start.
3. A window **closes** at the first `PullRequestReview` or `IssueComment` from a team member who is not the PR author.
4. If new `ReviewRequestedEvent`s appear after a window closes, a new window opens.
5. An open PR with an unclosed window is "waiting for review" — yielded as an open window.

Each window is yielded as it's computed (one PR at a time). Window shape:

- `pr: { number, title, url, repo, author }` — PR metadata
- `requestedAt: Temporal.Instant`
- `respondedAt: Temporal.Instant | null` — null if still waiting
- `respondedBy: string | null` — GitHub username of first responder, null if waiting
- `businessHours: number` — elapsed business hours (to now if still waiting)

### Aggregate Stats

**Overall team stats:**
- Median business hours across all closed review windows
- P90 (90th percentile) business hours

**Per first-responder stats:**
- For each team member: median, P90, and count of windows where they were the first responder
- Only includes team members who have at least one first response

**Waiting PRs:**
- Open PRs with an unclosed review window
- Current wait time in business hours (from window open to now)

### Median/P90 Calculation

Simple array-based:
- Sort values ascending
- Median: value at index `floor(length / 2)` (or average of two middle values)
- P90: value at index `floor(length * 0.9)`

## CLI Output (`output.ts`)

Uses `@std/fmt/colors` for ANSI coloring.

### Section 1: "Waiting for Review"

Sorted by longest wait first. Each entry as a list item:

```
🔴 repo-name#123 — "PR title" (8.2h waiting)
   Requested by @author
🟡 repo-name#456 — "Another PR" (5.1h waiting)
   Requested by @someone
🟢 repo-name#789 — "Quick fix" (1.3h waiting)
   Requested by @dev
```

Color thresholds:
- 🟢 Green: < 4 business hours
- 🟡 Yellow: 4–6 business hours
- 🔴 Red: > 6 business hours

If nothing waiting: `No PRs waiting for review! 🎉`

### Section 2: "Review Response Times (Last 30 Days)"

Overall team stats, then per-reviewer breakdown sorted by median (slowest first):

```
Overall: median 2.1h, P90 5.8h (42 reviews)

Per reviewer (first responder):
  @alice — median 1.5h, P90 3.2h (12 reviews)
  @bob — median 2.8h, P90 6.1h (15 reviews)
  @carol — median 4.2h, P90 8.0h (15 reviews)
```

### Time Formatting

- Under 6 business hours: `"2.3h"`
- 6+ business hours: `"1d 2.3h"` (where 1 day = 6 business hours)

## Testing

Uses `@std/testing` (BDD-style `describe`/`it`) and `@std/assert`. Run with `deno test`.

### `business-hours_test.ts`

- Same business day (e.g., Monday 11am → Monday 2pm = 3h)
- Across a single night (Monday 3pm → Tuesday 11am = 2h)
- Across a weekend (Friday 2pm → Monday 11am = 3h)
- Start outside business hours — before open (Monday 8am → Monday 2pm = 4h)
- Start outside business hours — after close (Monday 5pm → Tuesday 11am = 1h)
- Start on weekend (Saturday 12pm → Monday 2pm = 4h)
- End outside business hours — clamped back (Monday 10am → Monday 7pm = 6h)
- Multi-day span (Monday 10am → Wednesday 4pm = 18h)
- Zero elapsed (both times on weekend = 0h)
- DST spring-forward transition

### `metrics_test.ts`

- Single PR, single review request, single review → one closed window with correct timing
- Multiple review requests before response → de-duplicated to one window
- Multiple review cycles (request → review → re-request → review) → two windows
- Comment from team member counts as review response
- Comment from PR author does not close window
- Comment from non-team-member does not close window
- Open PR with pending review request → open window with `respondedAt: null`
- Median and P90 calculations with known values

## Verification

1. Run `deno test` — all tests pass
2. Run `deno run --allow-net --allow-env main.ts` with a valid `GITHUB_TOKEN`
3. Verify it fetches PRs from configured repos
4. Verify waiting PRs are listed with correct business-hours wait times
5. Verify historical stats show median/P90 per reviewer
6. Manually check a few PRs against GitHub UI to confirm timeline event parsing is correct
