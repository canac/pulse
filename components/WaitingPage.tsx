import { Layout } from "./Layout.tsx";
import type { ReviewWindow } from "../metrics.ts";
import { TEAM_MEMBERS, THRESHOLDS } from "../config.ts";
import { BUSINESS_HOURS } from "../config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

interface WaitingPageData {
  waitingByReviewer: Map<string, ReviewWindow[]>;
  lastUpdated: Date | null;
}

function statusClass(hours: number): string {
  if (hours < THRESHOLDS.warning) {
    return "ok";
  }
  return hours < THRESHOLDS.overdue ? "warning" : "overdue";
}

function formatHours(hours: number): string {
  if (hours < HOURS_PER_DAY) {
    return `${hours.toFixed(1)}h`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  const remainder = hours % HOURS_PER_DAY;
  return `${days}d ${remainder.toFixed(1)}h`;
}

function repoFromUrl(url: string): string {
  const match = url.match(/github\.com\/[^/]+\/([^/]+)/);
  return match?.[1] ?? "";
}

const AVATAR_COLORS = ["#7c6ff7", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"];

function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash + char.charCodeAt(0)) % AVATAR_COLORS.length;
  }
  return AVATAR_COLORS[hash];
}

export function WaitingPage({ data }: { data: WaitingPageData }) {
  return (
    <Layout activeTab="waiting" lastUpdated={data.lastUpdated}>
      {TEAM_MEMBERS.map((reviewer) => {
        const windows = data.waitingByReviewer.get(reviewer) ?? [];
        return (
          <div class="reviewer-group" key={reviewer}>
            <div class="reviewer-header">
              <div
                class="avatar"
                style={`background: ${avatarColor(reviewer)}`}
              >
                {reviewer[0].toUpperCase()}
              </div>
              <span class="reviewer-name">{reviewer}</span>
              <span class="badge">
                {windows.length} PR{windows.length !== 1 ? "s" : ""}
              </span>
            </div>
            {windows.length === 0
              ? <div class="no-prs">No PRs waiting</div>
              : (
                <div class="pr-list">
                  {windows.map((window) => (
                    <div
                      class={`pr-card border-${statusClass(window.businessHours)}`}
                      key={window.pr.url}
                    >
                      <div class="pr-card-row">
                        <div>
                          <a class="pr-link" href={window.pr.url}>
                            {repoFromUrl(window.pr.url)} #{window.pr.number}
                          </a>
                          <span class="pr-title">{window.pr.title}</span>
                        </div>
                        <span
                          class={`pr-hours status-${statusClass(window.businessHours)}`}
                        >
                          {formatHours(window.businessHours)}
                        </span>
                      </div>
                      <div class="pr-meta">
                        opened by {window.pr.author}
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        );
      })}
    </Layout>
  );
}
