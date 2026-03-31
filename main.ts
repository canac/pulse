import { load } from "@std/dotenv";
import { Spinner } from "@std/cli/unstable-spinner";
import { REPOS } from "./config.ts";
import { fetchPullRequests } from "./github.ts";
import {
  computeStats,
  extractReviewWindows,
  type ReviewWindow,
} from "./metrics.ts";
import { printStats, printWaiting } from "./output.ts";

import { parseArgs } from "@std/cli/parse-args";

const args = parseArgs(Deno.args, { boolean: ["cached"] });

const env = await load();
const token = env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: GITHUB_TOKEN must be set in .env file.");
  Deno.exit(1);
}

// Fetch all PRs (repos fetched in parallel)
let reposCompleted = 0;
const spinner = new Spinner({
  message: `Fetching PRs... (0/${REPOS.length} repos)`,
});
spinner.start();
const pullRequests = await fetchPullRequests(token, {
  useCache: args.cached,
  onRepoComplete: () => {
    reposCompleted++;
    spinner.message = `Fetching PRs... (${reposCompleted}/${REPOS.length} repos)`;
  },
});
spinner.stop();

// Extract review windows via sync generator, collect into array
const allWindows: ReviewWindow[] = extractReviewWindows(pullRequests).toArray();

// Split into closed (historical) and open (waiting)
const closedWindows = allWindows.filter((window) =>
  window.respondedAt !== null
);
const closedHours = closedWindows.map((window) => window.businessHours);

// Overall stats
const overall = computeStats(closedHours);

// Per-reviewer stats
const hoursByReviewer = new Map<string, number[]>();
for (const window of closedWindows) {
  if (window.respondedBy) {
    const existingHours = hoursByReviewer.get(window.respondedBy) ?? [];
    existingHours.push(window.businessHours);
    hoursByReviewer.set(window.respondedBy, existingHours);
  }
}

const perReviewerStats = new Map(
  [...hoursByReviewer.entries()].map(([name, hours]) => [
    name,
    computeStats(hours),
  ]),
);

// Print output
printWaiting(allWindows);
printStats(overall, perReviewerStats);
