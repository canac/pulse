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
  requestedReviewer: z.object({ login: z.string().optional() }).nullable(),
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

const PR_FIELDS = `
  number title url createdAt isDraft state
  author { login }
  timelineItems(first: 100, itemTypes: [
    REVIEW_REQUESTED_EVENT
    PULL_REQUEST_REVIEW
    ISSUE_COMMENT
  ]) {
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
      ... on PullRequestReview { createdAt author { login } }
      ... on IssueComment { createdAt author { login } }
    }
  }
`;

const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 100
        after: $cursor
        states: $states
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${PR_FIELDS}
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function graphqlRequest(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = await response.json();

  if (json.errors?.length) {
    const errorMessages = json.errors
      .map((err: { message: string }) => err.message)
      .join("; ");
    throw new Error(`GitHub GraphQL errors: ${errorMessages}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchAllPagesForRepo(
  token: string,
  repoName: string,
  since: Temporal.Instant,
  states: ("OPEN" | "MERGED" | "CLOSED")[],
): Promise<Array<PullRequest & { repo: string }>> {
  const pullRequests: Array<PullRequest & { repo: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const json = await graphqlRequest(token, PULL_REQUESTS_QUERY, {
      owner: GITHUB_ORG,
      name: repoName,
      cursor,
      states,
    });

    const { pullRequests: pullRequestsPage } = QueryResponseSchema.parse(json)
      .data.repository;

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

      pullRequests.push({ ...pullRequest, repo: repoName });
    }

    if (reachedOldPR || !pullRequestsPage.pageInfo.hasNextPage) {
      break;
    }
    cursor = pullRequestsPage.pageInfo.endCursor;
  }

  return pullRequests;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ALL_STATES: ("OPEN" | "MERGED" | "CLOSED")[] = [
  "OPEN",
  "MERGED",
  "CLOSED",
];

export async function fetchPullRequests(
  token: string,
  options: {
    states?: ("OPEN" | "MERGED" | "CLOSED")[];
  } = {},
): Promise<Array<PullRequest & { repo: string }>> {
  const since = Temporal.Now.instant().subtract({ hours: LOOKBACK_DAYS * 24 });
  const states = options.states ?? ALL_STATES;

  const results = await Promise.all(
    REPOS.map(async (repoName) => {
      const pullRequests = await fetchAllPagesForRepo(
        token,
        repoName,
        since,
        states,
      );
      return pullRequests;
    }),
  );

  return results.flat();
}

export async function fetchPullRequestsByNumber(
  token: string,
  repo: string,
  prNumbers: number[],
): Promise<Array<PullRequest & { repo: string }>> {
  if (prNumbers.length === 0) {
    return [];
  }

  const prQueries = prNumbers
    .map((num) => `pr_${num}: pullRequest(number: ${num}) { ${PR_FIELDS} }`)
    .join("\n    ");

  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${prQueries}
      }
    }
  `;

  const json = await graphqlRequest(token, query, {
    owner: GITHUB_ORG,
    name: repo,
  });

  const data = json as { data?: { repository?: Record<string, unknown> } };
  const repository = data.data?.repository;
  if (!repository) {
    return [];
  }

  const pullRequests: Array<PullRequest & { repo: string }> = [];
  for (const num of prNumbers) {
    const prData = repository[`pr_${num}`];
    if (prData) {
      const parsed = PullRequestSchema.parse(prData);
      pullRequests.push({ ...parsed, repo });
    }
  }

  return pullRequests;
}
