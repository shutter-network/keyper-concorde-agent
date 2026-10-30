// Runs inside Docker Compose. Agent mounts use paths on the Docker host.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Runtime } from "@shutter-network/concorde/signals";
import { signals } from "@shutter-network/concorde/signals/schema";
import { buildGateway, createAgentRuntime } from "../gateway.ts";
import * as schema from "../schema.ts";
import { startFakeBotApi } from "../telegram-channel/fake-bot-api.ts";
import { applySchema, createTestDatabase } from "../telegram-channel/test-support.ts";

const execute = promisify(execFile);

/** "team", then one operator room per keyper: "a", "b", ... Each operator room covers `kpr-<room>`, API set. */
export type Room = string;

export type HarnessOptions = {
  /** Operator rooms to create. Default 2. */
  readonly keypers?: number;
  /**
   * pi's settings, relative to the repository. Default: the deployment's settings.json.
   * The runner reads it from /config under the same file name, so compose.behaviour.yml mounts it there.
   */
  readonly settings?: string;
  /** pi's models.json, relative to the repository. Default: the deployment's models.json. */
  readonly models?: string;
};

export type SendOptions = {
  /** The Run must fail, rather than the scenario failing because it did. */
  readonly expectFailure?: boolean;
};

export const runId = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
export const transcriptPath = join("/results", runId, "transcript.txt");

export type Sent = { readonly to: Room; readonly text: string };

export type AgentRun = {
  readonly from: Room;
  readonly text: string;
  readonly sent: readonly Sent[];
  /** Rooms that received at least one message from this run, in room order. */
  readonly recipients: readonly Room[];
  /** Parsed coordination.json, or undefined if the file does not exist. */
  readonly file: unknown;
  /** Messages from this run to one room, joined with newlines. */
  to(room: Room): string;
};

export type Harness = {
  readonly ids: Readonly<Record<Room, string>>;
  /** "team" followed by the operator rooms. */
  readonly rooms: readonly Room[];
  /** The operator rooms, "a", "b", ... */
  readonly operators: readonly Room[];
  /** The keyper instance an operator room covers. */
  instance(room: Room): string;
  /** Send a message and wait for the agent to finish. */
  send(room: Room, text: string, options?: SendOptions): Promise<AgentRun>;
  /** Restart the gateway. Workspace and sessions are kept. */
  restart(): Promise<void>;
  /** All messages sent to a room during this scenario. */
  messagesTo(room: Room): string;
  /** Write a file under the agent's /workspace; `path` is relative to it. */
  writeWorkspace(path: string, text: string): Promise<void>;
  /** Read a file under /workspace; undefined if missing. */
  readWorkspace(path: string): Promise<string | undefined>;
  /** Save the results and close the scenario. Call once. */
  finish(failure?: unknown): Promise<void>;
};

type Settings = { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
type SignalRow = { state: string; error: string | null };
type Logger = Record<"debug" | "info" | "warn" | "error", (...args: unknown[]) => void>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Missing environment variable ${name}. Use ./run.sh.`);
  return value;
}

function fileLogger(path: string): Logger {
  const record = (level: string) => (...args: unknown[]) => {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), level, args })}\n`);
  };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

async function writeTranscriptHeader(model: string): Promise<void> {
  try {
    await writeFile(transcriptPath, `run ${runId}, requested ${model}\n\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// The transcript truncates messages; report.json keeps the full text.
const textWidth = 84;

function oneLine(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= textWidth ? flat : `${flat.slice(0, textWidth - 1)}…`;
}

function fileSummary(file: unknown, operators: readonly Room[], ids: Readonly<Record<Room, string>>): string {
  if (file === undefined) return "none";
  const text = JSON.stringify(file);
  const named = operators.filter((room) => text.includes(ids[room]));
  return named.length === 0 ? "empty" : `round with ${named.join(", ")}`;
}

// Read the first recorded provider/model and thinking level from the session files.
// Compare them with settings.json to detect a model fallback or thinking-level change.
async function modelThatRan(sessionsDir: string): Promise<string | undefined> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await walk(sessionsDir);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const match = /"provider":"([^"]+)","model":"([^"]+)"/.exec(text);
    if (!match) continue;
    const level = /"thinkingLevel":"([^"]+)"/.exec(text);
    return `${match[1]}/${match[2]}${level ? `, thinking ${level[1]}` : ""}`;
  }
  return undefined;
}

function transcriptBlock(scenario: string, runs: readonly AgentRun[], operators: readonly Room[], ids: Readonly<Record<Room, string>>, ran: string | undefined, failure?: string): string {
  const arrow = (from: string, to: string) => `${from.padEnd(4)} -> ${to.padEnd(4)}  `;
  const lines = [`${scenario}  ${failure === undefined ? "PASS" : "FAIL"}  ${runs.length} runs, ran ${ran ?? "no model"}`, ""];
  let previousFile = "";
  for (const run of runs) {
    lines.push(`${arrow(run.from, "bot")}${oneLine(run.text)}`);
    for (const message of run.sent) lines.push(`${arrow("bot", message.to)}${oneLine(message.text)}`);
    const file = fileSummary(run.file, operators, ids);
    if (file !== previousFile) lines.push(`${" ".repeat(14)}file: ${file}`);
    previousFile = file;
    lines.push("");
  }
  if (failure !== undefined) lines.push(`FAIL  ${failure}`, "");
  return `${lines.join("\n")}\n`;
}

export async function startHarness(scenario: string, options: HarnessOptions = {}): Promise<Harness> {
  const keypers = options.keypers ?? 2;
  assert.ok(Number.isInteger(keypers) && keypers >= 1 && keypers <= 26, `keypers must be 1 to 26, got ${keypers}`);
  const operators: Room[] = Array.from({ length: keypers }, (_, index) => String.fromCharCode(97 + index));
  const rooms: Room[] = ["team", ...operators];
  const chatIds: Record<Room, number> = Object.fromEntries(rooms.map((room, index) => [room, -100800001 - index]));
  const senderIds: Record<Room, number> = Object.fromEntries(rooms.map((room, index) => [room, 900001 + index]));
  const instance = (room: Room): string => `kpr-${room}`;
  const suiteHost = requiredEnv("KEYPER_TESTS_DIR");
  const repoHost = dirname(suiteHost);
  const timeoutMs = Number(process.env.TURN_TIMEOUT_SECONDS ?? "600") * 1000;
  const directory = join("/results", runId, scenario);
  const hostDirectory = join(suiteHost, "results", runId, scenario);
  await mkdir(join(directory, "workspace"), { recursive: true });
  await mkdir(join(directory, "agent"), { recursive: true });
  const log = fileLogger(join(directory, "gateway.log"));

  const settingsPath = options.settings ?? "settings.json";
  const modelsPath = options.models ?? "models.json";
  const settings = JSON.parse(await readFile(join("/config", basename(settingsPath)), "utf8")) as Settings;
  const model = `${settings.defaultProvider}/${settings.defaultModel}, thinking ${settings.defaultThinkingLevel ?? "default"}`;
  await writeTranscriptHeader(model);

  const database = await createTestDatabase(`behaviour_${randomUUID().replaceAll("-", "")}`);
  await applySchema(database.db, schema);
  const api = await startFakeBotApi();

  // Track the container so it can be removed on timeout.
  const image = requiredEnv("AGENT_IMAGE");
  let container: string | undefined;
  let containers = 0;
  const hostPath = (...parts: string[]) => join(...parts).slice(1); // relative to runtimeDir "/"
  const runtime: Runtime = {
    async run(prompt) {
      const name = `keyper-behaviour-${runId}-${scenario}-${++containers}`;
      container = name;
      // The production runtime, with this scenario's paths and a name to remove it by on timeout.
      const pi = createAgentRuntime({
        image,
        network: "keyper_behaviour_agent",
        serverUrl: "http://runner:7411",
        runtimeDir: "/",
        paths: {
          workspace: hostPath(hostDirectory, "workspace"),
          state: hostPath(hostDirectory, "agent"),
          agentsMd: hostPath(hostDirectory, "AGENTS.md"),
          settings: hostPath(repoHost, settingsPath),
          models: hostPath(repoHost, modelsPath),
          systemMd: hostPath(repoHost, "SYSTEM.md"),
        },
        extraArgs: ["--name", name],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void execute("docker", ["rm", "-f", name]).catch(() => undefined);
      }, timeoutMs);
      try {
        const outcome = await pi.run(prompt);
        return timedOut ? { ok: false, error: `Agent run exceeded ${timeoutMs / 1000}s` } : outcome;
      } finally {
        clearTimeout(timer);
        container = undefined;
      }
    },
  };

  const newGateway = () =>
    buildGateway({
      databaseUrl: database.url,
      runtime,
      logger: log,
      publicListen: { host: "127.0.0.1", port: 0 },
      agentListen: { host: "0.0.0.0", port: 7411 },
      telegram: { token: "000000:TEST", apiBaseUrl: api.url, pollTimeoutSeconds: 1, retryDelayMs: 100 },
    });
  let gateway = newGateway();

  // Each scenario has its own users and team ID.
  const ids = {} as Record<Room, string>;
  for (const room of rooms) {
    ids[room] = await gateway.components.db.tx(async (tx) => {
      const user = await gateway.components.users.create(tx);
      const name = room === "team" ? "Test team" : `Operator ${room.toUpperCase()}`;
      await gateway.components.users.setAttributes(tx, user.id, room === "team"
        ? { kind: "teammate", name }
        : { kind: "keyper", name, keypers: [{ instance: instance(room), set: "api" }], operators: [String(senderIds[room])] });
      await gateway.components.telegram.recordChat(tx, user.id, String(chatIds[room]));
      return user.id;
    });
  }
  await writeFile(join(directory, "AGENTS.md"), await readFile("/config/AGENTS.md", "utf8"));
  await gateway.start();

  const signalRows = (): Promise<SignalRow[]> => gateway.components.db.handle({}).select().from(signals);
  async function readRoundFile(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(directory, "workspace/coordination.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  let updateCount = 0;
  const runs: AgentRun[] = [];
  let ranModel: string | undefined;
  const roomForChat = (chatId: string): Room => {
    const room = rooms.find((candidate) => String(chatIds[candidate]) === chatId);
    assert.ok(room, `Message sent to unknown chat ${chatId}`);
    return room;
  };

  return {
    ids,
    rooms,
    operators,
    instance,
    async writeWorkspace(path, text) {
      const target = join(directory, "workspace", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
    async readWorkspace(path) {
      try {
        return await readFile(join(directory, "workspace", path), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async send(room, text, sendOptions = {}) {
      const sentBefore = api.sent.length;
      const id = ++updateCount;
      api.push({
        update_id: id,
        message: {
          message_id: id,
          text: `/reply ${text}`,
          chat: { id: chatIds[room], type: "supergroup" },
          from: { id: senderIds[room], username: `test_${room}` },
        },
      });
      // Wait for the signal to finish before reading messages and state.
      const deadline = Date.now() + timeoutMs + 30_000;
      let rows: SignalRow[];
      for (;;) {
        rows = await signalRows();
        if (rows.length === id && rows.every((row) => row.state === "done" || row.state === "failed")) break;
        assert.ok(Date.now() < deadline, `Agent run timed out for ${room}: ${JSON.stringify(text)}`);
        await new Promise((resume) => setTimeout(resume, 100));
      }
      await gateway.components.telegram.drain();
      const sent = api.sent.slice(sentBefore).map((message) => ({ to: roomForChat(message.chatId), text: message.text }));
      const run: AgentRun = {
        from: room,
        text,
        sent,
        recipients: rooms.filter((candidate) => sent.some((message) => message.to === candidate)),
        file: await readRoundFile(),
        to: (target) => sent.filter((message) => message.to === target).map((message) => message.text).join("\n"),
      };
      runs.push(run);
      const ran = await modelThatRan(join(directory, "agent/sessions"));
      if (ran !== undefined) {
        ranModel ??= ran;
        // Check the recorded model and thinking level against the requested configuration.
        const expected = `${settings.defaultProvider}/${settings.defaultModel}`
          + (settings.defaultThinkingLevel ? `, thinking ${settings.defaultThinkingLevel}` : "");
        const matches = settings.defaultThinkingLevel ? ran === expected : ran.split(",")[0] === expected;
        assert.ok(matches, `settings.json asks for ${expected} but the Run used ${ran}`);
      }
      const failed = rows.find((row) => row.state === "failed");
      if (sendOptions.expectFailure) {
        assert.ok(failed !== undefined, `Agent run was expected to fail for ${room}; input: ${JSON.stringify(text)}`);
      } else {
        assert.ok(failed === undefined, `Agent run failed for ${room}: ${failed?.error}; input: ${JSON.stringify(text)}`);
      }
      return run;
    },
    async restart() {
      await gateway.stop();
      gateway = newGateway();
      await gateway.start();
    },
    messagesTo(room) {
      return runs.flatMap((run) => run.sent.filter((message) => message.to === room).map((message) => message.text)).join("\n");
    },
    async finish(failure) {
      const error = failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure);
      await appendFile(transcriptPath, transcriptBlock(scenario, runs, operators, ids, ranModel, error));
      await writeFile(join(directory, "report.json"), `${JSON.stringify({ scenario, passed: error === undefined, error, requested: model, ran: ranModel, ids, runs }, null, 2)}\n`);
      if (container !== undefined) await execute("docker", ["rm", "-f", container]).catch(() => undefined);
      await gateway.stop();
      await api.stop();
      await database.drop();
    },
  };
}
