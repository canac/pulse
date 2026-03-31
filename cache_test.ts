import { afterEach, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  type CachedPullRequest,
  cacheKey,
  loadCache,
  loadCacheUpdatedAt,
  saveCache,
} from "./cache.ts";

function makeCachedPR(
  repo: string,
  number: number,
): CachedPullRequest {
  return {
    repo,
    number,
    title: `Test PR #${number}`,
    url: `https://github.com/CruGlobal/${repo}/pull/${number}`,
    createdAt: "2026-03-30T14:00:00Z",
    isDraft: false,
    state: "OPEN",
    author: { login: "someauthor" },
    timelineItems: { nodes: [] },
  };
}

afterEach(async () => {
  await caches.delete("pulse");
});

describe("cacheKey", () => {
  it("formats as repo#number", () => {
    assertEquals(cacheKey("mpdx-react", 123), "mpdx-react#123");
  });
});

describe("loadCache", () => {
  it("returns empty map when cache does not exist", async () => {
    const cache = await loadCache();
    assertEquals(cache.size, 0);
  });

  it("loads saved cache and keys by repo#number", async () => {
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    await saveCache(original);

    const cache = await loadCache();

    assertEquals(cache.size, 1);
    assertEquals(cache.has("mpdx-react#42"), true);
    assertEquals(cache.get("mpdx-react#42")!.title, "Test PR #42");
  });
});

describe("saveCache", () => {
  it("round-trips through loadCache", async () => {
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    original.set(
      "staff_accounting_app#10",
      makeCachedPR("staff_accounting_app", 10),
    );

    await saveCache(original);
    const loaded = await loadCache();

    assertEquals(loaded.size, 2);
    assertEquals(loaded.get("mpdx-react#42")!.number, 42);
    assertEquals(loaded.get("staff_accounting_app#10")!.number, 10);
  });
});

describe("loadCacheUpdatedAt", () => {
  it("returns null when cache does not exist", async () => {
    const updatedAt = await loadCacheUpdatedAt();
    assertEquals(updatedAt, null);
  });

  it("returns a date after saving", async () => {
    const before = new Date();
    const cache = new Map<string, CachedPullRequest>();
    cache.set("mpdx-react#1", makeCachedPR("mpdx-react", 1));
    await saveCache(cache);

    const updatedAt = await loadCacheUpdatedAt();

    assertEquals(updatedAt instanceof Date, true);
    assertEquals(updatedAt!.getTime() >= before.getTime(), true);
  });
});
