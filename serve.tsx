import { Hono } from "hono";
import { getToken, LOOKBACK_DAYS } from "./config.ts";
import {
  getDb,
  getLastFetchedAt,
  loadReviewWindows,
  type ReviewWindowView,
} from "./db.ts";
import { sync } from "./sync.ts";
import { computeStats } from "./metrics.ts";
import {
  computeReviewerDetails,
  computeWeeklyTrend,
  groupWaitingByReviewer,
} from "./web-data.ts";
import { WaitingPage } from "./components/WaitingPage.tsx";
import { ResponseTimesPage } from "./components/ResponseTimesPage.tsx";

const SWR_COOLDOWN_MS = 5 * 60 * 1000;
let lastFetchedAt = 0;

function backgroundRefresh(): void {
  const token = getToken();
  const database = getDb();
  const startTime = performance.now();
  sync(token, database).then(() => {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`Background refresh complete in ${elapsed}s`);
  }).catch((error) => {
    console.error("Background refresh failed:", error);
  });
}

function maybeRefreshInBackground(): void {
  if (Date.now() - lastFetchedAt > SWR_COOLDOWN_MS) {
    lastFetchedAt = Date.now();
    backgroundRefresh();
  }
}

function loadWindowsAndMeta(): {
  allWindows: ReviewWindowView[];
  lastUpdated: Date | null;
} {
  const database = getDb();
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });

  const allWindows = loadReviewWindows(database, since.toString());
  const lastUpdated = getLastFetchedAt(database);

  return { allWindows, lastUpdated };
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

app.get("/", (ctx) => {
  const { allWindows, lastUpdated } = loadWindowsAndMeta();
  maybeRefreshInBackground();
  return ctx.html(
    <WaitingPage
      waitingByReviewer={groupWaitingByReviewer(allWindows)}
      lastUpdated={lastUpdated}
    />,
  );
});

app.get("/response-times", (ctx) => {
  const { allWindows, lastUpdated } = loadWindowsAndMeta();
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
  backgroundRefresh();
  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;
  Deno.serve({ port }, app.fetch);
}
