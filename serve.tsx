import { Hono } from "hono";
import { CACHE_PATH, getToken, LOOKBACK_DAYS } from "./config.ts";
import { cacheKey, loadCache, saveCache } from "./cache.ts";
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

const app = new Hono();

app.use(async (ctx, next) => {
  try {
    const filePath = `./static${ctx.req.path}`;
    const stat = await Deno.stat(filePath);
    if (!stat.isFile) {
      return await next();
    }
    const file = await Deno.open(filePath, { read: true });
    const headers: Record<string, string> = {};
    if (filePath.endsWith(".css")) {
      headers["content-type"] = "text/css; charset=utf-8";
    }
    return new Response(file.readable, { headers });
  } catch {
    return await next();
  }
});

app.get("/", async (ctx) => {
  const { allWindows, lastUpdated } = await loadWindowsAndMeta();
  maybeRefreshInBackground();
  return ctx.html(
    <WaitingPage
      waitingByReviewer={groupWaitingByReviewer(allWindows)}
      lastUpdated={lastUpdated}
    />,
  );
});

app.get("/response-times", async (ctx) => {
  const { allWindows, lastUpdated } = await loadWindowsAndMeta();
  const closedWindows = allWindows.filter((window) =>
    window.respondedAt !== null
  );
  maybeRefreshInBackground();
  return ctx.html(
    <ResponseTimesPage
      overall={computeStats(
        closedWindows.map((window) => window.businessHours),
      )}
      trend={computeWeeklyTrend(allWindows)}
      reviewerDetails={computeReviewerDetails(allWindows)}
      lastUpdated={lastUpdated}
    />,
  );
});

export function startServer(): void {
  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;
  Deno.serve({ port }, app.fetch);
}
