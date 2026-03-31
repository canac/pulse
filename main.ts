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
