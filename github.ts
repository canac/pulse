import { z } from "zod";
import { GITHUB_ORG, LOOKBACK_DAYS, REPOS } from "./config.ts";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const ActorSchema = z.object({
  login: z.string(),
}).nullable();

const ReviewRequestedEventSchema = z.object({
  __typename: z.literal("ReviewRequestedEvent"),
  createdAt: z.string(),
  requestedReviewer: z.object({ login: z.string() }).nullable(),
});

const PullRequestReviewSchema = z.object({
  __typename: z.literal("PullRequestReview"),
  createdAt: z.string(),
  author: ActorSchema,
});

const IssueCommentSchema = z.object({
  __typename: z.literal("IssueComment"),
  createdAt: z.string(),
  author: ActorSchema,
});

const TimelineItemSchema = z.discriminatedUnion("__typename", [
  ReviewRequestedEventSchema,
  PullRequestReviewSchema,
  IssueCommentSchema,
]);

const PullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  author: ActorSchema,
  timelineItems: z.object({
    nodes: z.array(TimelineItemSchema),
  }),
});

const QueryResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(PullRequestSchema),
      }),
    }),
  }),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// ---------------------------------------------------------------------------
// GraphQL Query
// ---------------------------------------------------------------------------

const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 100
        after: $cursor
        states: [OPEN, MERGED, CLOSED]
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title url createdAt mergedAt isDraft state
          author { login }
          timelineItems(first: 100, itemTypes: [
            REVIEW_REQUESTED_EVENT
            PULL_REQUEST_REVIEW
            ISSUE_COMMENT
          ]) {
            nodes {
              __typename
              ... on ReviewRequestedEvent {
                createdAt
                requestedReviewer { ... on User { login } }
              }
              ... on PullRequestReview {
                createdAt
                author { login }
              }
              ... on IssueComment {
                createdAt
                author { login }
              }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function graphql(
  token: string,
  variables: Record<string, unknown>,
): Promise<z.infer<typeof QueryResponseSchema>> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: PULL_REQUESTS_QUERY, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();

  if (json.errors && json.errors.length > 0) {
    const errorMessages = json.errors
      .map((err: { message: string }) => err.message)
      .join("; ");
    throw new Error(`GitHub GraphQL errors: ${errorMessages}`);
  }

  return QueryResponseSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Async Generator
// ---------------------------------------------------------------------------

export async function* fetchPullRequests(
  token: string,
): AsyncGenerator<PullRequest> {
  const since = Temporal.Now.instant().subtract({ hours: LOOKBACK_DAYS * 24 });

  for (const repoName of REPOS) {
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await graphql(token, {
        owner: GITHUB_ORG,
        name: repoName,
        cursor,
      });

      const pullRequestsPage =
        result.data.repository.pullRequests;
      const pageInfo = pullRequestsPage.pageInfo;

      let reachedOldPR = false;

      for (const pullRequest of pullRequestsPage.nodes) {
        if (pullRequest.isDraft) {
          continue;
        }

        const prCreatedAt = Temporal.Instant.from(pullRequest.createdAt);
        if (Temporal.Instant.compare(prCreatedAt, since) < 0) {
          reachedOldPR = true;
          break;
        }

        yield pullRequest;
      }

      if (reachedOldPR || !pageInfo.hasNextPage) {
        hasNextPage = false;
      } else {
        cursor = pageInfo.endCursor;
        hasNextPage = pageInfo.hasNextPage;
      }
    }
  }
}
