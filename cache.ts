import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

const CACHE_NAME = "pulse";
const CACHE_URL = "https://pulse/pull-requests";

export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export async function loadCache(): Promise<Map<string, CachedPullRequest>> {
  try {
    const webCache = await caches.open(CACHE_NAME);
    const response = await webCache.match(CACHE_URL);
    if (!response) {
      return new Map();
    }
    const pullRequests: CachedPullRequest[] = await response.json();
    const cache = new Map<string, CachedPullRequest>();
    for (const pullRequest of pullRequests) {
      cache.set(cacheKey(pullRequest.repo, pullRequest.number), pullRequest);
    }
    return cache;
  } catch {
    return new Map();
  }
}

export async function saveCache(
  cache: Map<string, CachedPullRequest>,
): Promise<void> {
  const pullRequests = Array.from(cache.values());
  const webCache = await caches.open(CACHE_NAME);
  await webCache.put(
    CACHE_URL,
    new Response(JSON.stringify(pullRequests), {
      headers: {
        "content-type": "application/json",
        "x-updated-at": new Date().toISOString(),
      },
    }),
  );
}

export async function loadCacheUpdatedAt(): Promise<Date | null> {
  try {
    const webCache = await caches.open(CACHE_NAME);
    const response = await webCache.match(CACHE_URL);
    if (!response) {
      return null;
    }
    const updatedAt = response.headers.get("x-updated-at");
    response.body?.cancel();
    return updatedAt ? new Date(updatedAt) : null;
  } catch {
    return null;
  }
}
