import type { DatabaseSync } from "node:sqlite";
import { LOOKBACK_DAYS, REPOS } from "./config.ts";
import {
  type FetchPagesResult,
  fetchPullRequests,
  fetchTimeline,
} from "./github.ts";
import {
  getOpenPullRequests,
  getRepoCursor,
  type PullRequestRow,
  setLastFetchedAt,
  setRepoCursor,
  updateTimelineCursor,
  upsertPullRequest,
} from "./db.ts";
import { ingestTimelineEvents } from "./ingest.ts";

async function fetchAndIngestTimeline(
  token: string,
  database: DatabaseSync,
  pullRequest: PullRequestRow,
): Promise<void> {
  let cursor = pullRequest.timeline_cursor;

  while (true) {
    const timeline = await fetchTimeline(token, pullRequest.node_id, cursor);

    upsertPullRequest(database, {
      repo: pullRequest.repo,
      number: pullRequest.number,
      nodeId: pullRequest.node_id,
      title: timeline.title,
      url: pullRequest.url,
      author: pullRequest.author,
      state: timeline.state,
      isDraft: timeline.isDraft,
      createdAt: pullRequest.created_at,
    });

    ingestTimelineEvents(
      database,
      pullRequest.repo,
      pullRequest.number,
      pullRequest.author,
      timeline.events,
    );

    cursor = timeline.endCursor;

    if (!timeline.hasNextPage) {
      break;
    }
  }

  if (cursor !== null) {
    updateTimelineCursor(
      database,
      pullRequest.repo,
      pullRequest.number,
      cursor,
    );
  }
}

async function ingestNewPRs(
  token: string,
  database: DatabaseSync,
  results: Map<string, FetchPagesResult>,
): Promise<void> {
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });

  for (const [repo, result] of results) {
    for (const pullRequest of result.pullRequests) {
      if (pullRequest.isDraft) {
        continue;
      }

      const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
      if (Temporal.Instant.compare(prCreatedAt, since) < 0) {
        continue;
      }

      upsertPullRequest(database, {
        repo: pullRequest.repo,
        number: pullRequest.number,
        nodeId: pullRequest.id,
        title: pullRequest.title,
        url: pullRequest.url,
        author: pullRequest.author?.login ?? "ghost",
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        createdAt: pullRequest.createdAt,
      });

      await fetchAndIngestTimeline(token, database, {
        repo: pullRequest.repo,
        number: pullRequest.number,
        node_id: pullRequest.id,
        title: pullRequest.title,
        url: pullRequest.url,
        author: pullRequest.author?.login ?? "ghost",
        state: pullRequest.state,
        is_draft: pullRequest.isDraft ? 1 : 0,
        created_at: pullRequest.createdAt,
        timeline_cursor: null,
      });
    }

    if (result.endCursor !== null) {
      setRepoCursor(database, repo, result.endCursor);
    }
  }
}

export async function initialLoad(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  const results = await fetchPullRequests(token);
  await ingestNewPRs(token, database, results);
  setLastFetchedAt(database, new Date());
}

export async function incrementalRefresh(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  const newPRs = async () => {
    const cursors = new Map<string, string | null>();
    for (const repo of REPOS) {
      cursors.set(repo, getRepoCursor(database, repo));
    }
    const results = await fetchPullRequests(token, { cursors });
    await ingestNewPRs(token, database, results);
  };

  const openPRTimelines = async () => {
    const openPullRequests = getOpenPullRequests(database);
    await Promise.all(
      openPullRequests.map((pullRequest) =>
        fetchAndIngestTimeline(token, database, pullRequest)
      ),
    );
  };

  await Promise.all([newPRs(), openPRTimelines()]);
  setLastFetchedAt(database, new Date());
}

export async function sync(
  token: string,
  database: DatabaseSync,
): Promise<void> {
  if (getRepoCursor(database, REPOS[0]) === null) {
    await initialLoad(token, database);
  } else {
    await incrementalRefresh(token, database);
  }
}
