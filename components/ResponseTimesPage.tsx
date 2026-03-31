import type { PageProps } from "fresh";
import { Layout } from "./Layout.tsx";
import type { ReviewWindow, Stats } from "../metrics.ts";
import type { ReviewerDetail, WeekBucket } from "../web-data.ts";
import { BUSINESS_HOURS, THRESHOLDS } from "../config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

interface ResponseTimesData {
  overall: Stats;
  trend: WeekBucket[];
  reviewerDetails: ReviewerDetail[];
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

function formatWeekLabel(isoDate: string): string {
  const date = Temporal.PlainDate.from(isoDate);
  return date.toLocaleString("en-US", { month: "short", day: "numeric" });
}

function OverallStats({ overall }: { overall: Stats }) {
  if (overall.count === 0) {
    return <div class="empty-state">No review data in this period.</div>;
  }
  return (
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-label">Median</div>
        <div class={`stat-value status-${statusClass(overall.median)}`}>
          {formatHours(overall.median)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">P90</div>
        <div class={`stat-value status-${statusClass(overall.p90)}`}>
          {formatHours(overall.p90)}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Reviews</div>
        <div class="stat-value" style="color: var(--color-link)">
          {overall.count}
        </div>
      </div>
    </div>
  );
}

function WeeklyChart({ trend }: { trend: WeekBucket[] }) {
  if (trend.length === 0) {
    return null;
  }
  const maxMedian = Math.max(...trend.map((bucket) => bucket.median));
  return (
    <div>
      <div class="section-title">Weekly Trend (Median Response Time)</div>
      <div class="chart-container">
        <div class="chart">
          {trend.map((bucket) => {
            const heightPercent = maxMedian > 0
              ? (bucket.median / maxMedian) * 100
              : 0;
            return (
              <div class="bar" key={bucket.weekStart}>
                <span class="bar-label">{formatHours(bucket.median)}</span>
                <div
                  class={`bar-fill bg-${statusClass(bucket.median)}`}
                  style={`height: ${heightPercent}%`}
                />
              </div>
            );
          })}
        </div>
        <div class="chart-labels">
          {trend.map((bucket) => (
            <div class="chart-label" key={bucket.weekStart}>
              {formatWeekLabel(bucket.weekStart)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewerTable(
  { reviewerDetails }: { reviewerDetails: ReviewerDetail[] },
) {
  if (reviewerDetails.length === 0) {
    return null;
  }
  return (
    <div>
      <div class="section-title">Per Reviewer</div>
      <div class="reviewer-table">
        <div class="table-header">
          <div>Reviewer</div>
          <div>Median</div>
          <div>P90</div>
          <div>Count</div>
        </div>
        {reviewerDetails.map((detail) => (
          <ReviewerRow detail={detail} key={detail.reviewer} />
        ))}
      </div>
    </div>
  );
}

function ReviewerRow({ detail }: { detail: ReviewerDetail }) {
  return (
    <details class="reviewer-row">
      <summary>
        <div class="reviewer-cell">
          <div
            class="avatar-sm"
            style={`background: ${avatarColor(detail.reviewer)}`}
          >
            {detail.reviewer[0].toUpperCase()}
          </div>
          <span>{detail.reviewer}</span>
          <span class="expand-indicator">&#9654;</span>
        </div>
        <div class={`status-${statusClass(detail.stats.median)}`}>
          {formatHours(detail.stats.median)}
        </div>
        <div class={`status-${statusClass(detail.stats.p90)}`}>
          {formatHours(detail.stats.p90)}
        </div>
        <div style="color: var(--text-secondary)">{detail.stats.count}</div>
      </summary>
      <div class="drill-down">
        <div class="drill-down-header">
          Recent reviews by {detail.reviewer}:
        </div>
        <div class="drill-down-list">
          {detail.windows.map((window) => (
            <div class="drill-down-item" key={window.pr.url}>
              <span>
                <a href={window.pr.url}>
                  {repoFromUrl(window.pr.url)} #{window.pr.number}
                </a>
                {" "}
                <span class="drill-down-title">{window.pr.title}</span>
              </span>
              <span class={`status-${statusClass(window.businessHours)}`}>
                {formatHours(window.businessHours)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function ResponseTimesPage({ data }: PageProps<ResponseTimesData>) {
  return (
    <Layout activeTab="response-times" lastUpdated={data.lastUpdated}>
      <OverallStats overall={data.overall} />
      <WeeklyChart trend={data.trend} />
      <ReviewerTable reviewerDetails={data.reviewerDetails} />
    </Layout>
  );
}
