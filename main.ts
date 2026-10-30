import { buildGateway, createAgentRuntime } from "./gateway.ts";
import { describeCoverage, type KeyperRef } from "./prompt.ts";

const runtime = createAgentRuntime({
  image: process.env.AGENT_IMAGE!,
  network: process.env.AGENT_NETWORK!,
  serverUrl: process.env.AGENT_SERVER_URL!,
  runtimeDir: process.env.RUNTIME_DIR_HOST!,
  paths: {
    workspace: "state/workspace",
    state: "state/agent",
    agentsMd: "AGENTS.md",
    settings: "settings.json",
    models: "models.json",
    systemMd: "SYSTEM.md",
  },
});

const gateway = buildGateway({
  databaseUrl: process.env.DATABASE_URL!,
  runtime,
  publicListen: { host: process.env.PUBLIC_HOST!, port: Number(process.env.PUBLIC_PORT) },
  agentListen: { host: process.env.AGENT_HOST!, port: Number(process.env.AGENT_PORT) },
  telegram: { token: process.env.TG_TOKEN! },
});

await gateway.start();

await gateway.components.scheduler.schedule({
  name: "weekly-uptime-report",
  spec: { kind: "cron", expr: "0 14 * * 1", tz: "UTC" },
  data: { reportDir: "/workspace/reports" },
});

// Do not create default Users at startup. Register groups through `admin.ts`, which saves
// the chat link and any keyper assignment together. This avoids creating Users that cannot
// receive messages or keyper groups with no assigned keyper.
//
// Log groups with no assigned Keypers at startup. Their messages fail with UnboundGroupError.
const groups = await gateway.components.users.list();
console.log(`gateway is up, serving ${groups.length} group${groups.length === 1 ? "" : "s"}`);
for (const group of groups) {
  const { name, kind, keypers } = (group.attributes ?? {}) as {
    name?: string;
    kind?: string;
    keypers?: readonly KeyperRef[];
  };
  const covers = describeCoverage(Array.isArray(keypers) ? keypers : []);
  console.log(
    kind === "teammate"
      ? `  ${name ?? "(unnamed)"} is a teammate chat`
      : `  ${name ?? "(unnamed)"} covers ${covers ?? "nothing; run admin.ts add-keypers for it"}`,
  );
}
if (groups.length === 0) console.log("  none registered yet; see admin.ts add-keyper-chat");

for (const stopping of ["SIGINT", "SIGTERM"] as const) {
  process.once(stopping, () => void gateway.stop());
}
