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
  it("returns empty map for nonexistent file", () => {
    const cache = loadCache("/tmp/nonexistent-review-cache.json");
    assertEquals(cache.size, 0);
  });

  it("returns empty map for malformed JSON", () => {
    const path = Deno.makeTempFileSync();
    Deno.writeTextFileSync(path, "not valid json {{{");
    const cache = loadCache(path);
    assertEquals(cache.size, 0);
    Deno.removeSync(path);
  });

  it("loads valid cache and keys by repo#number", () => {
    const path = Deno.makeTempFileSync();
    const data = [makeCachedPR("mpdx-react", 42)];
    Deno.writeTextFileSync(path, JSON.stringify(data));

    const cache = loadCache(path);

    assertEquals(cache.size, 1);
    assertEquals(cache.has("mpdx-react#42"), true);
    assertEquals(cache.get("mpdx-react#42")!.title, "Test PR #42");
    Deno.removeSync(path);
  });
});

describe("saveCache", () => {
  it("round-trips through loadCache", () => {
    const path = Deno.makeTempFileSync();
    const original = new Map<string, CachedPullRequest>();
    original.set("mpdx-react#42", makeCachedPR("mpdx-react", 42));
    original.set(
      "staff_accounting_app#10",
      makeCachedPR("staff_accounting_app", 10),
    );

    saveCache(path, original);
    const loaded = loadCache(path);

    assertEquals(loaded.size, 2);
    assertEquals(loaded.get("mpdx-react#42")!.number, 42);
    assertEquals(loaded.get("staff_accounting_app#10")!.number, 10);
    Deno.removeSync(path);
  });
});
