import { Hono } from "hono";
import { getToken, LOOKBACK_DAYS } from "./config.ts";
import {
  getDb,
  getLastFetchedAt,
  initDb,
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

export async function backgroundRefresh(): Promise<void> {
  const token = getToken();
  const client = getDb();
  const startTime = performance.now();
  try {
    await sync(token, client);
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    console.log(`Background refresh complete in ${elapsed}s`);
  } catch (error) {
    console.error("Background refresh failed:", error);
  }
}

async function loadWindowsAndMeta(): Promise<{
  allWindows: ReviewWindowView[];
  lastUpdated: Date | null;
}> {
  const client = getDb();
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });

  const allWindows = await loadReviewWindows(client, since.toString());
  const lastUpdated = await getLastFetchedAt(client);

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

app.get("/", async (ctx) => {
  const { allWindows, lastUpdated } = await loadWindowsAndMeta();
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

export async function startServer(): Promise<void> {
  await initDb();
  backgroundRefresh();
  const portEnv = Deno.env.get("PORT");
  const port = portEnv ? Number(portEnv) : undefined;
  Deno.serve({ port }, app.fetch);
}
