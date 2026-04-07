import type { Client } from "@libsql/client";
import { LOOKBACK_DAYS, REPOS, TEAM_MEMBERS } from "./config.ts";
import {
  type FetchPagesResult,
  fetchPullRequests,
  fetchTimeline,
} from "./github.ts";
import {
  getAllRepoCursors,
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
  client: Client,
  pullRequest: PullRequestRow,
): Promise<void> {
  let cursor = pullRequest.timeline_cursor;

  while (true) {
    const timeline = await fetchTimeline(token, pullRequest.node_id, cursor);

    await upsertPullRequest(client, {
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

    await ingestTimelineEvents(
      client,
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
    await updateTimelineCursor(
      client,
      pullRequest.repo,
      pullRequest.number,
      cursor,
    );
  }
}

async function ingestNewPRs(
  token: string,
  client: Client,
  results: Map<string, FetchPagesResult>,
): Promise<void> {
  const since = Temporal.Now.instant().subtract({
    hours: LOOKBACK_DAYS * 24,
  });
  const teamMemberSet = new Set<string>(TEAM_MEMBERS);

  for (const [repo, result] of results) {
    for (const pullRequest of result.pullRequests) {
      const authorLogin = pullRequest.author?.login;
      if (!authorLogin || !teamMemberSet.has(authorLogin)) {
        continue;
      }

      if (pullRequest.isDraft) {
        continue;
      }

      const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
      if (Temporal.Instant.compare(prCreatedAt, since) < 0) {
        continue;
      }

      await upsertPullRequest(client, {
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

      await fetchAndIngestTimeline(token, client, {
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
      await setRepoCursor(client, repo, result.endCursor);
    }
  }
}

export async function initialLoad(
  token: string,
  client: Client,
): Promise<void> {
  const results = await fetchPullRequests(token);
  await ingestNewPRs(token, client, results);
  await setLastFetchedAt(client, new Date());
}

export async function incrementalRefresh(
  token: string,
  client: Client,
): Promise<void> {
  const newPRs = async () => {
    const allCursors = await getAllRepoCursors(client);
    const cursors = new Map<string, string | null>(
      REPOS.map((repo) => [repo, allCursors.get(repo) ?? null]),
    );
    const results = await fetchPullRequests(token, { cursors });
    await ingestNewPRs(token, client, results);
  };

  const openPRTimelines = async () => {
    const openPullRequests = await getOpenPullRequests(client);
    await Promise.all(
      openPullRequests.map((pullRequest) =>
        fetchAndIngestTimeline(token, client, pullRequest)
      ),
    );
  };

  await Promise.all([newPRs(), openPRTimelines()]);
  await setLastFetchedAt(client, new Date());
}

export async function sync(
  token: string,
  client: Client,
): Promise<void> {
  if (await getRepoCursor(client, REPOS[0]) === null) {
    await initialLoad(token, client);
  } else {
    await incrementalRefresh(token, client);
  }
}
