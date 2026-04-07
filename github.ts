import { z } from "zod";
import { GITHUB_ORG, REPOS } from "./config.ts";

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
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  author: ActorSchema,
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

const TimelineResponseSchema = z.object({
  data: z.object({
    node: z.object({
      title: z.string(),
      state: z.enum(["OPEN", "MERGED", "CLOSED"]),
      isDraft: z.boolean(),
      timelineItems: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(TimelineItemSchema),
      }),
    }),
  }),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

// ---------------------------------------------------------------------------
// GraphQL Queries
// ---------------------------------------------------------------------------

const PR_FIELDS = `
  id number title url createdAt isDraft state
  author { login }
`;

const PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $cursor: String, $states: [PullRequestState!]) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: 100
        after: $cursor
        states: $states
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${PR_FIELDS}
        }
      }
    }
  }
`;

const TIMELINE_QUERY = `
  query($nodeId: ID!, $cursor: String) {
    node(id: $nodeId) {
      ... on PullRequest {
        title
        state
        isDraft
        timelineItems(
          first: 100
          after: $cursor
          itemTypes: [REVIEW_REQUESTED_EVENT PULL_REQUEST_REVIEW ISSUE_COMMENT]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
            ... on PullRequestReview { createdAt author { login } }
            ... on IssueComment { createdAt author { login } }
          }
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

export interface FetchPagesResult {
  pullRequests: Array<PullRequest & { repo: string }>;
  endCursor: string | null;
}

async function fetchAllPagesForRepo(
  token: string,
  repoName: string,
  states: ("OPEN" | "MERGED" | "CLOSED")[],
  startCursor: string | null,
): Promise<FetchPagesResult> {
  const pullRequests: Array<PullRequest & { repo: string }> = [];
  let cursor = startCursor;

  while (true) {
    const json = await graphqlRequest(token, PULL_REQUESTS_QUERY, {
      owner: GITHUB_ORG,
      name: repoName,
      cursor,
      states,
    });

    const { pullRequests: pullRequestsPage } = QueryResponseSchema.parse(json)
      .data.repository;

    for (const pullRequest of pullRequestsPage.nodes) {
      pullRequests.push({ ...pullRequest, repo: repoName });
    }

    cursor = pullRequestsPage.pageInfo.endCursor;

    if (!pullRequestsPage.pageInfo.hasNextPage) {
      break;
    }
  }

  return { pullRequests, endCursor: cursor };
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
    cursors?: Map<string, string | null>;
  } = {},
): Promise<Map<string, FetchPagesResult>> {
  const states = options.states ?? ALL_STATES;
  const cursors = options.cursors ?? new Map();

  const results = new Map<string, FetchPagesResult>();

  const fetches = REPOS.map(async (repoName) => {
    const startCursor = cursors.get(repoName) ?? null;
    const result = await fetchAllPagesForRepo(
      token,
      repoName,
      states,
      startCursor,
    );
    results.set(repoName, result);
  });

  await Promise.all(fetches);
  return results;
}

export interface TimelineResult {
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  events: TimelineItem[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export async function fetchTimeline(
  token: string,
  nodeId: string,
  cursor: string | null,
): Promise<TimelineResult> {
  const json = await graphqlRequest(token, TIMELINE_QUERY, {
    nodeId,
    cursor,
  });

  const parsed = TimelineResponseSchema.parse(json);
  const { title, state, isDraft, timelineItems } = parsed.data.node;

  return {
    title,
    state,
    isDraft,
    events: timelineItems.nodes,
    endCursor: timelineItems.pageInfo.endCursor,
    hasNextPage: timelineItems.pageInfo.hasNextPage,
  };
}
