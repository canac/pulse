import { bold, green, red, yellow } from "@std/fmt/colors";
import type { ReviewWindow, Stats } from "./metrics.ts";
import { BUSINESS_HOURS, THRESHOLDS } from "./config.ts";

const HOURS_PER_DAY = BUSINESS_HOURS.end - BUSINESS_HOURS.start;

function formatHours(hours: number): string {
  if (hours < HOURS_PER_DAY) {
    return `${hours.toFixed(1)}h`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  const remainder = hours % HOURS_PER_DAY;
  return `${days}d ${remainder.toFixed(1)}h`;
}

function colorize(hours: number, text: string): string {
  if (hours < THRESHOLDS.warning) return green(text);
  if (hours < THRESHOLDS.overdue) return yellow(text);
  return red(text);
}

function urgencyEmoji(hours: number): string {
  if (hours < THRESHOLDS.warning) return "🟢";
  if (hours < THRESHOLDS.overdue) return "🟡";
  return "🔴";
}

export function printWaiting(windows: ReviewWindow[]): void {
  console.log(bold("\n📋 Waiting for Review\n"));

  const waiting = windows
    .filter((window) => window.respondedAt === null)
    .sort((windowA, windowB) => windowB.businessHours - windowA.businessHours);

  if (waiting.length === 0) {
    console.log("  No PRs waiting for review! 🎉\n");
    return;
  }

  for (const window of waiting) {
    const time = formatHours(window.businessHours);
    const emoji = urgencyEmoji(window.businessHours);
    const colored = colorize(window.businessHours, `${time} waiting`);
    console.log(
      `  ${emoji} ${window.pr.url} — "${window.pr.title}" (${colored})`,
    );
    console.log(`     Opened by @${window.pr.author}`);
  }
  console.log();
}

export function printStats(
  overall: Stats,
  perReviewer: Map<string, Stats>,
): void {
  console.log(bold("📊 Review Response Times (Last 30 Days)\n"));

  if (overall.count === 0) {
    console.log("  No review data in this period.\n");
    return;
  }

  console.log(
    `  Overall: median ${formatHours(overall.median)}, P90 ${
      formatHours(overall.p90)
    } (${overall.count} reviews)`,
  );
  console.log();

  const sorted = [...perReviewer.entries()].sort(
    (entryA, entryB) => entryB[1].median - entryA[1].median,
  );

  if (sorted.length > 0) {
    console.log("  Per reviewer (first responder):");
    for (const [reviewer, stats] of sorted) {
      const medianStr = colorize(
        stats.median,
        `median ${formatHours(stats.median)}`,
      );
      const p90Str = colorize(stats.p90, `P90 ${formatHours(stats.p90)}`);
      console.log(
        `    @${reviewer} — ${medianStr}, ${p90Str} (${stats.count} reviews)`,
      );
    }
  }
  console.log();
}
