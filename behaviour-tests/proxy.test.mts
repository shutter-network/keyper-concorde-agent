// Runs inside Docker Compose (compose.proxy.yml). Agent mounts use paths on the Docker host.
//
// Checks the LiteLLM proxy path with a fake Anthropic API in this process: a message gets a reply
// through the proxy, the provider key reaches the upstream but not the agent container, and a
// failed model call sends the failure message to the chat.
//
// The runtime and failure handler below copy main.ts. The credential check guards this copy, not
// main.ts itself; keep both in sync.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { createGateway } from "@shutter-network/concorde/gateway";
import { createMessenger, messageReceivedKind, type MessageRecord } from "@shutter-network/concorde/messenger";
import { createPasswordAuth } from "@shutter-network/concorde/password-auth";
import { createPiRuntime } from "@shutter-network/concorde/pi";
import { templateHandler, type PostOutcome, type Signal } from "@shutter-network/concorde/signals";
import { signals } from "@shutter-network/concorde/signals/schema";
import { createUsers } from "@shutter-network/concorde/users";
import * as schema from "../schema.ts";
import { startFakeBotApi } from "../telegram-channel/fake-bot-api.ts";
import { createTelegramChannel } from "../telegram-channel/index.ts";
import { applySchema, createTestDatabase, silent } from "../telegram-channel/test-support.ts";
import { failureMessage, promptData, template } from "../prompt.ts";

const providerKey = "dummy-provider-key";
const model = "claude-haiku-4-5";
const replyText = "proxy-ok";
const chatId = -100900001;
const runTimeoutMs = 180_000;

// --- Fake Anthropic API -------------------------------------------------------------------------

type Upstream = { headers: IncomingMessage["headers"]; body: AnthropicRequest };
type AnthropicRequest = {
  model: string;
  stream?: boolean;
  messages: { role: string; content: string | { type: string; content?: unknown }[] }[];
  tools?: { name: string }[];
};
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** What the fake returns: a scripted reply that posts to `userId`, or an error that is not retried. */
let mode: { reply: string } | "fail" = "fail";
const upstream: Upstream[] = [];

function toolResultOf(request: AnthropicRequest): string | undefined {
  const last = request.messages.at(-1);
  if (!last || typeof last.content === "string") return undefined;
  const result = last.content.find((block) => block.type === "tool_result");
  return result === undefined ? undefined : JSON.stringify(result.content);
}

function answer(request: AnthropicRequest, userId: string): { blocks: Block[]; stop: string } {
  if (toolResultOf(request) !== undefined) return { blocks: [{ type: "text", text: "done" }], stop: "end_turn" };
  assert.ok(request.tools?.some((tool) => tool.name === "bash"), "the agent offered no bash tool");
  const body = JSON.stringify({ userId, text: replyText });
  const command = `env; curl -s -X POST "$AGENT_SERVER_URL/messages/" -H 'content-type: application/json' -d '${body}'`;
  return { blocks: [{ type: "tool_use", id: "toolu_proxy_1", name: "bash", input: { command } }], stop: "tool_use" };
}

function writeStream(response: ServerResponse, blocks: Block[], stop: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: { id: "msg_proxy", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  response.end();
}

async function startFakeAnthropic(): Promise<{ stop(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(text) as AnthropicRequest;
    upstream.push({ headers: request.headers, body });
    if (mode === "fail") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "proxy test failure" } }));
      return;
    }
    const { blocks, stop } = answer(body, mode.reply);
    if (body.stream) {
      writeStream(response, blocks, stop);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg_proxy", type: "message", role: "assistant", model, content: blocks, stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(8090, "0.0.0.0", resolve));
  return { stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

// --- Gateway, as main.ts sets it up -------------------------------------------------------------

const testsHost = process.env.KEYPER_TESTS_DIR;
assert.ok(testsHost, "Missing environment variable KEYPER_TESTS_DIR. Use ./run-proxy.sh.");
assert.equal(process.env.ANTHROPIC_API_KEY, providerKey, "the runner must hold the dummy key so forwarding it would show");
const repoHost = dirname(testsHost);
const runDir = `proxy-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`;
const hostPath = (...parts: string[]) => join(...parts).slice(1); // relative to runtimeDir "/"

const runtime = createPiRuntime({
  image: process.env.AGENT_IMAGE!,
  env: {
    AGENT_SERVER_URL: "http://runner:7411",
  },
  networks: ["keyper_proxy_agent"],
  mounts: {
    runtimeDir: "/",
    entries: [
      { agentPath: "/workspace", path: hostPath(testsHost, "results", runDir, "workspace") },
      { agentPath: "/home/agent/.pi/agent", path: hostPath(testsHost, "results", runDir, "agent") },
      { agentPath: "/workspace/AGENTS.md", path: hostPath(repoHost, "AGENTS.md"), readOnly: true },
      { agentPath: "/home/agent/.pi/agent/settings.json", path: hostPath(testsHost, "proxy", "settings.json"), readOnly: true },
      { agentPath: "/home/agent/.pi/agent/models.json", path: hostPath(testsHost, "proxy", "models.json"), readOnly: true },
      { agentPath: "/home/agent/.pi/agent/SYSTEM.md", path: hostPath(repoHost, "SYSTEM.md"), readOnly: true },
    ],
  },
});

const database = await createTestDatabase(`proxy_${randomUUID().replaceAll("-", "")}`);
await applySchema(database.db, schema);
const api = await startFakeBotApi();
const fake = await startFakeAnthropic();
await mkdir(join("/results", runDir, "workspace"), { recursive: true });
await mkdir(join("/results", runDir, "agent"), { recursive: true });

const gateway = createGateway({
  databaseUrl: database.url,
  runtime,
  logger: silent,
  publicListen: { host: "127.0.0.1", port: 0 },
  agentListen: { host: "0.0.0.0", port: 7411 },
  extend: ({ db, agentServer, publicServer, worker }) => {
    const users = createUsers({ db, agentServer, publicServer });
    const passwordAuth = createPasswordAuth({ db, users, publicServer, tokenTtl: 30 * 24 * 60 * 60 * 1000 });
    const messenger = createMessenger({ db, users, worker, agentServer });
    const telegram = createTelegramChannel({
      db, messenger, token: "000000:TEST", apiBaseUrl: api.url, pollTimeoutSeconds: 1, retryDelayMs: 100, logger: silent,
      chatMode: "group",
    });
    return { users, passwordAuth, messenger, telegram };
  },
  handlers: ({ db, messenger, telegram, users }) => ({
    [messageReceivedKind]: {
      ...templateHandler<MessageRecord>({
        template,
        session: (signal) => `user_${signal.payload.userId}`,
        data: async (signal) => {
          const sender = await db.tx((tx) => telegram.senderOf(tx, signal.payload.id));
          const user = await users.get(signal.payload.userId);
          return promptData(signal.payload, sender, user?.attributes);
        },
      }),
      async post(signal: Signal<MessageRecord>, outcome: PostOutcome) {
        if (!outcome.failed) return;
        await db.tx((tx) => messenger.send(tx, signal.payload.userId, failureMessage));
      },
    },
  }),
});

let teamId = "";
let updates = 0;

/** Send a message from the team's chat, wait for its Run, and return what the bot sent back. */
async function send(text: string): Promise<string[]> {
  const sentBefore = api.sent.length;
  const id = ++updates;
  api.push({
    update_id: id,
    message: { message_id: id, text: `/reply ${text}`, chat: { id: chatId, type: "supergroup" }, from: { id: 900001, username: "test_team" } },
  });
  const deadline = Date.now() + runTimeoutMs;
  for (;;) {
    const rows: { state: string }[] = await gateway.components.db.handle({}).select().from(signals);
    if (rows.length === id && rows.every((row) => row.state === "done" || row.state === "failed")) break;
    assert.ok(Date.now() < deadline, `Run timed out for ${JSON.stringify(text)}`);
    await new Promise((resume) => setTimeout(resume, 100));
  }
  await gateway.components.telegram.drain();
  return api.sent.slice(sentBefore).filter((message) => message.chatId === String(chatId)).map((message) => message.text);
}

before(async () => {
  teamId = await gateway.components.db.tx(async (tx) => {
    const user = await gateway.components.users.create(tx);
    await gateway.components.users.setAttributes(tx, user.id, { kind: "teammate", name: "Test team" });
    await gateway.components.telegram.recordChat(tx, user.id, String(chatId));
    return user.id;
  });
  await gateway.start();
});

after(async () => {
  await gateway.stop();
  await fake.stop();
  await api.stop();
  await database.drop();
});

// --- Tests --------------------------------------------------------------------------------------

test("a message gets a reply through LiteLLM, and only the upstream sees the provider key", async () => {
  mode = { reply: teamId };
  upstream.length = 0;
  const replies = await send("hello");

  assert.deepEqual(replies, [replyText]);
  assert.equal(upstream.length, 2, "expected a tool call and a final answer");
  for (const request of upstream) {
    assert.equal(request.headers["x-api-key"], providerKey);
    assert.equal(request.body.model, model);
  }
  const env = toolResultOf(upstream[1]!.body);
  assert.ok(env?.includes("AGENT_SERVER_URL="), "the tool result holds no env output");
  assert.ok(!env.includes(providerKey), "the agent container's environment holds the provider key");
});

test("a failed model call sends the failure message to the chat", async () => {
  mode = "fail";
  upstream.length = 0;
  const replies = await send("hello again");

  assert.ok(upstream.length >= 1, "the request never reached the upstream");
  assert.deepEqual(replies, [failureMessage]);
});
