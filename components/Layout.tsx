import type { Child } from "hono/jsx";

export function Layout(
  { activeTab, children, lastUpdated }: {
    activeTab: "waiting" | "response-times";
    children: Child;
    lastUpdated: Date | null;
  },
) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Review Dashboard</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <nav class="nav">
          <a href="/" class={activeTab === "waiting" ? "active" : ""}>
            Waiting for Review
          </a>
          <a
            href="/response-times"
            class={activeTab === "response-times" ? "active" : ""}
          >
            Response Times
          </a>
        </nav>
        <div class="content">
          <div class="last-updated">
            Last updated: {formatRelativeTime(lastUpdated)}
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}

function formatRelativeTime(date: Date | null): string {
  if (!date) {
    return "never";
  }
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
}
