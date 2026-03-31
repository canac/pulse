import "@std/dotenv/load";

export const TEAM_MEMBERS = [
  "canac",
  "dr-bizz",
  "kegrimes",
  "wjames111",
  "zweatshirt",
] as const;

export const GITHUB_ORG = "CruGlobal";

export const REPOS = [
  "conf-registration-web",
  "give-web",
  "mpdx_api",
  "mpdx-react",
  "staff_accounting_app",
] as const;

export const BUSINESS_HOURS = {
  start: 9,
  end: 17,
  tz: "America/New_York",
} as const;

export const LOOKBACK_DAYS = 30;

/** Review wait time thresholds in business hours. */
export const THRESHOLDS = {
  /** 4+ business hours — needs attention */
  warning: 4,
  /** 8+ business hours — overdue */
  overdue: 8,
} as const;

export function getToken(): string {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) {
    throw new Error("GITHUB_TOKEN must be set in environment or .env file");
  }
  return token;
}
