# Fresh Web Dashboard Design

Add a `serve` subcommand that starts a Fresh 2.0 web server, providing a browser-based view of the review dashboard data.

## Pages

### Page 1: PRs Waiting for Review (`/`)

Displays open PRs that have pending review requests, **grouped by requested reviewer**. Each reviewer gets a section with their avatar initial, name, and PR count badge. Within each group, PRs are sorted by longest wait time first.

Each PR card shows:
- Repo name + PR number (linked to GitHub)
- PR title
- Wait time in business hours (right-aligned)
- PR author
- Color-coded left border: green (<4h), yellow (4–8h), red (8+h) — same thresholds as CLI

Reviewers with no pending PRs are shown with "No PRs waiting" so you can see who's available.

### Page 2: Review Response Times (`/response-times`)

Three sections:

**Overall stats cards:** Median, P90, and total review count displayed as large numbers in card boxes at the top.

**Weekly trend chart:** Bar chart showing median response time per week over the 30-day window. Pure CSS bars (no charting library). Bars are color-coded using the same green/yellow/red thresholds. Week labels on the x-axis.

**Per-reviewer table:** Grid with columns: reviewer, median, P90, count, expand arrow. Each row is a `<details>`/`<summary>` element. Expanding shows that reviewer's individual review windows (PR link, title, response time) rendered server-side inside the `<details>` body — no additional fetches, no JS.

## Architecture

### File Structure

```
review-dashboard/
├── main.ts              # Modified: arg parsing for `serve` subcommand
├── serve.ts             # Fresh app setup + SWR refresh logic
├── routes/
│   ├── _app.tsx         # Shared layout (HTML shell, nav, global CSS)
│   ├── index.tsx        # Waiting for review page
│   └── response-times.tsx  # Response times page
├── fresh.config.ts      # Fresh configuration
```

### Entry Point

`main.ts` gains a `serve` subcommand. `deno task start` runs the CLI as today. `deno task start serve` (or a new `deno task serve`) starts the Fresh web server. The serve path imports `serve.ts` which calls Fresh's app startup.

### Port Configuration

The server port is read from the `PORT` environment variable. If omitted, pass `port: undefined` to Fresh (which lets the framework pick a default).

### Reused Modules

All existing modules are imported directly by the route handlers — no API layer:
- `cache.ts` — `loadCache()` (async) and `saveCache()`
- `metrics.ts` — `extractReviewWindows()` and `computeStats()`
- `business-hours.ts` — `businessHoursElapsed()`
- `config.ts` — `TEAM_MEMBERS`, `THRESHOLDS`, `REPOS`, etc.
- `github.ts` — `fetchPullRequests()` and `fetchPullRequestsByNumber()`

### SWR Strategy

On each page request:
1. `await loadCache("cache.json")` — read current cache from disk
2. Extract review windows and compute stats from cached data
3. Render and return HTML immediately (stale-while-revalidate: serve stale)
4. Check `lastFetchedAt` (module-level variable in `serve.ts`). If more than 5 minutes have elapsed, fire off a background fetch (no `await`) that runs the same incremental fetch strategy as the CLI (fetch OPEN PRs, detect state transitions, fetch changed PRs by number, save cache)
5. Next page load sees the refreshed data

No client-side polling or auto-refresh. The page shows a "Last updated" timestamp so the user knows how fresh the data is.

### Shared Cache

The web server reads and writes the same `cache.json` file as the CLI. No locking needed — the existing cache write strategy (write temp file, rename) is atomic. If the CLI runs while the server is up, the server picks up the fresh cache on next request.

### Weekly Trend Data

Computed server-side from existing review windows by bucketing `respondedAt` timestamps into ISO weeks. No additional storage — it's a derived view over the same 30-day data.

## UI Principles

- **Clean HTML/CSS, minimal JS.** The only interactive element is `<details>`/`<summary>` for drill-down, which is native HTML.
- **Chrome-only target.** Use modern CSS freely: container queries, `:has()`, `@layer`, etc.
- **Dark theme** consistent with the mockups (dark backgrounds, light text).
- **Color coding** uses the same thresholds as the CLI: green (<4h), yellow (4–8h), red (8+h).
- **Tab navigation** between the two pages at the top of every page.
- CSS lives in the `_app.tsx` layout as a `<style>` block or a static CSS file — no inline styles.

## Data Flow Summary

```
cache.json (disk)
  ↓ await loadCache()
Map<string, PullRequest>
  ↓ extractReviewWindows()
ReviewWindow[] (open windows + closed windows)
  ↓ computeStats() / bucket by week / group by reviewer
Page-specific view data
  ↓ Fresh SSR
HTML response
  ↓ (background, if cooldown elapsed)
GitHub API fetch → updated cache.json
```

## What This Design Does NOT Include

- No client-side JavaScript beyond native HTML behavior
- No WebSocket or polling for live updates
- No authentication (runs on localhost)
- No database — cache.json is the only persistence
- No separate API endpoints — pages are server-rendered directly
