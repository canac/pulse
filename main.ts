import { backgroundRefresh, startServer } from "./serve.tsx";

Deno.cron("sync github data", "*/5 * * * *", () => backgroundRefresh());

await startServer();
