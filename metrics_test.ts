import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { computeStats, extractReviewWindows } from "./metrics.ts";
import type { PullRequest } from "./github.ts";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makePR(overrides: {
  number?: number;
  author?: string;
  timelineItems: PullRequest["timelineItems"]["nodes"];
}): PullRequest {
  return {
    number: overrides.number ?? 1,
    title: "Test PR",
    url: "https://github.com/org/repo/pull/1",
    createdAt: "2026-03-30T14:00:00Z",
    isDraft: false,
    state: "OPEN",
    author: { login: overrides.author ?? "someauthor" },
    timelineItems: { nodes: overrides.timelineItems },
  };
}

// ---------------------------------------------------------------------------
// extractReviewWindows tests
// ---------------------------------------------------------------------------

describe("extractReviewWindows", () => {
  it("single request + review yields one closed window", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "canac" },
        },
        {
          __typename: "PullRequestReview",
          createdAt: "2026-03-30T15:00:00Z",
          author: { login: "canac" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 1);
    assertEquals(
      windows[0].requestedAt,
      Temporal.Instant.from("2026-03-30T14:00:00Z"),
    );
    assertEquals(
      windows[0].respondedAt,
      Temporal.Instant.from("2026-03-30T15:00:00Z"),
    );
    assertEquals(windows[0].respondedBy, "canac");
    assertEquals(windows[0].pr.author, "someauthor");
  });

  it("multiple review requests before response are de-duplicated to one window", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "canac" },
        },
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:30:00Z",
          requestedReviewer: { login: "dr-bizz" },
        },
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:45:00Z",
          requestedReviewer: { login: "kegrimes" },
        },
        {
          __typename: "PullRequestReview",
          createdAt: "2026-03-30T15:00:00Z",
          author: { login: "dr-bizz" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    // Should produce exactly one window starting at the first request
    assertEquals(windows.length, 1);
    assertEquals(
      windows[0].requestedAt,
      Temporal.Instant.from("2026-03-30T14:00:00Z"),
    );
    assertEquals(windows[0].respondedBy, "dr-bizz");
  });

  it("two review cycles produce two windows", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        // First cycle
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "canac" },
        },
        {
          __typename: "PullRequestReview",
          createdAt: "2026-03-30T15:00:00Z",
          author: { login: "canac" },
        },
        // Second cycle
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T16:00:00Z",
          requestedReviewer: { login: "wjames111" },
        },
        {
          __typename: "PullRequestReview",
          createdAt: "2026-03-30T17:00:00Z",
          author: { login: "wjames111" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 2);
    assertEquals(windows[0].respondedBy, "canac");
    assertEquals(windows[1].respondedBy, "wjames111");
    assertEquals(
      windows[1].requestedAt,
      Temporal.Instant.from("2026-03-30T16:00:00Z"),
    );
  });

  it("IssueComment from team member counts as review response", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "zweatshirt" },
        },
        {
          __typename: "IssueComment",
          createdAt: "2026-03-30T15:30:00Z",
          author: { login: "zweatshirt" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedBy, "zweatshirt");
    assertEquals(
      windows[0].respondedAt,
      Temporal.Instant.from("2026-03-30T15:30:00Z"),
    );
  });

  it("IssueComment from PR author does NOT close window", () => {
    const pullRequest = makePR({
      author: "canac",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "dr-bizz" },
        },
        {
          __typename: "IssueComment",
          createdAt: "2026-03-30T14:30:00Z",
          // canac is a team member BUT also the PR author — should be ignored
          author: { login: "canac" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    // Window should still be open (respondedAt: null) since author's comment doesn't count
    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].respondedBy, null);
  });

  it("IssueComment from non-team-member does NOT close window", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "canac" },
        },
        {
          __typename: "IssueComment",
          createdAt: "2026-03-30T14:30:00Z",
          // external-contributor is NOT a team member
          author: { login: "external-contributor" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    // Window should still be open
    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].respondedBy, null);
  });

  it("review request to non-team-member is ignored entirely", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "external-contributor" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();
    assertEquals(windows.length, 0);
  });

  it("open PR with pending request yields window with respondedAt null", () => {
    const pullRequest = makePR({
      author: "someauthor",
      timelineItems: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-30T14:00:00Z",
          requestedReviewer: { login: "kegrimes" },
        },
      ],
    });

    const windows = extractReviewWindows([pullRequest]).toArray();

    assertEquals(windows.length, 1);
    assertEquals(windows[0].respondedAt, null);
    assertEquals(windows[0].respondedBy, null);
    assertEquals(
      windows[0].requestedAt,
      Temporal.Instant.from("2026-03-30T14:00:00Z"),
    );
    // businessHours should be a non-negative number
    assertEquals(windows[0].businessHours >= 0, true);
  });
});

// ---------------------------------------------------------------------------
// computeStats tests
// ---------------------------------------------------------------------------

describe("computeStats", () => {
  it("array of 10 values has correct median (5.5), P90 (9), count (10)", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stats = computeStats(values);

    assertEquals(stats.count, 10);
    assertEquals(stats.median, 5.5);
    assertEquals(stats.p90, 9);
  });

  it("single value has that value for both median and P90", () => {
    const stats = computeStats([42]);

    assertEquals(stats.count, 1);
    assertEquals(stats.median, 42);
    assertEquals(stats.p90, 42);
  });

  it("empty array returns all zeros", () => {
    const stats = computeStats([]);

    assertEquals(stats.median, 0);
    assertEquals(stats.p90, 0);
    assertEquals(stats.count, 0);
  });
});
