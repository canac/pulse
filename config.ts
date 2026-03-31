export const TEAM_MEMBERS = [
  // TODO: fill in actual GitHub usernames before first run
  "alice",
  "bob",
  "carol",
] as const;

export const REPOS = [
  // TODO: fill in actual repos before first run
  { owner: "my-org", name: "repo-one" },
  { owner: "my-org", name: "repo-two" },
] as const;

export const BUSINESS_HOURS = {
  start: 10,
  end: 16,
  tz: "America/New_York",
} as const;

export const LOOKBACK_DAYS = 30;

/** Review wait time thresholds in business hours. */
export const THRESHOLDS = {
  /** 4+ business hours — needs attention */
  warning: 4,
  /** 6+ business hours — overdue */
  overdue: 6,
} as const;
