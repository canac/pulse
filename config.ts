export const TEAM_MEMBERS = [
  "canac",
  "dr-bizz",
  "kegrimes",
  "wjames111",
  "zweatshirt",
] as const;

export const REPOS = [
  { owner: "CruGlobal", name: "conf-registration-web" },
  { owner: "CruGlobal", name: "mpdx-react" },
  { owner: "CruGlobal", name: "staff_accounting_app" },
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
