import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import {
  type CachedPullRequest,
  cacheKey,
  loadCache,
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

describe("cacheKey", () => {
  it("formats as repo#number", () => {
    assertEquals(cacheKey("mpdx-react", 123), "mpdx-react#123");
  });
});

describe("loadCache", () => {
  it("returns empty map for nonexistent file", async () => {
    const cache = await loadCache("/tmp/nonexistent-review-cache.json");
    assertEquals(cache.size, 0);
  });

  it("returns empty map for malformed JSON", async () => {
    const path = await Deno.makeTempFile();
    await Deno.writeTextFile(path, "not valid json {{{");
    const cache = await loadCache(path);
    assertEquals(cache.size, 0);
    await Deno.remove(path);
  });

  it("loads valid cache and keys by repo#number", async () => {
    const path = await Deno.makeTempFile();
    const data = [makeCachedPR("mpdx-react", 42)];
    await Deno.writeTextFile(path, JSON.stringify(data));

    const cache = await loadCache(path);

    assertEquals(cache.size, 1);
    assertEquals(cache.has("mpdx-react#42"), true);
    assertEquals(cache.get("mpdx-react#42")!.title, "Test PR #42");
    await Deno.remove(path);
  });
});

describe("saveCache", () => {
  it("round-trips through loadCache", async () => {
    const path = await Deno.makeTempFile();
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    original.set(
      "staff_accounting_app#10",
      makeCachedPR("staff_accounting_app", 10),
    );

    await saveCache(path, original);
    const loaded = await loadCache(path);

    assertEquals(loaded.size, 2);
    assertEquals(loaded.get("mpdx-react#42")!.number, 42);
    assertEquals(loaded.get("staff_accounting_app#10")!.number, 10);
    await Deno.remove(path);
  });
});
