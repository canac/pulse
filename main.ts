import { parseArgs } from "@std/cli/parse-args";

const args = parseArgs(Deno.args, { boolean: ["cached"] });

if (args._[0] === "serve") {
  const { startServer } = await import("./serve.tsx");
  startServer();
} else {
  const { runCli } = await import("./cli.ts");
  await runCli({ cached: args.cached ?? false });
}
