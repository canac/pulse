import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export async function loadCache(
  path: string,
): Promise<Map<string, CachedPullRequest>> {
  try {
    const json = await Deno.readTextFile(path);
    const pullRequests: CachedPullRequest[] = JSON.parse(json);
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
  path: string,
  cache: Map<string, CachedPullRequest>,
): Promise<void> {
  const pullRequests = Array.from(cache.values());
  await Deno.writeTextFile(path, JSON.stringify(pullRequests));
}
