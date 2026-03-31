import { App, page, staticFiles } from "fresh";
import { CACHE_PATH, getToken, LOOKBACK_DAYS } from "./config.ts";
import {
  cacheKey,
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
    // deno-lint-ignore no-explicit-any
    component: WaitingPage as any,
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
    // deno-lint-ignore no-explicit-any
    component: ResponseTimesPage as any,
  });

  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;
  await app.listen({ port });
}
