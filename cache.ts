import type { PullRequest } from "./github.ts";

export type CachedPullRequest = PullRequest & { repo: string };

export function cacheKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

export function loadCache(path: string): Map<string, CachedPullRequest> {
  try {
    const json = Deno.readTextFileSync(path);
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

export function saveCache(
  path: string,
  cache: Map<string, CachedPullRequest>,
): void {
  const pullRequests = Array.from(cache.values());
  Deno.writeTextFileSync(path, JSON.stringify(pullRequests));
}
