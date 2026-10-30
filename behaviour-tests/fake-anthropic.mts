// A stand-in for api.anthropic.com on runner:8090, which `./run.sh proxy` points LiteLLM at.
// It records every request, and answers either as a scripted model that posts one reply through
// the agent's bash tool, or with an error that is not retried.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const replyText = "proxy-ok";

export type AnthropicRequest = {
  model: string;
  stream?: boolean;
  messages: { role: string; content: string | { type: string; content?: unknown }[] }[];
  tools?: { name: string }[];
};

export type Upstream = { headers: IncomingMessage["headers"]; body: AnthropicRequest };

export type FakeAnthropic = {
  /** Every request received, in order. */
  readonly requests: Upstream[];
  /** Answer as a model that posts `replyText` to this user, prints its env, and then ends its turn. */
  reply(userId: string): void;
  /** Answer every request with HTTP 400 `invalid_request_error`. */
  fail(): void;
  stop(): Promise<void>;
};

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** The tool result in the request's last message, as JSON text, or undefined if it has none. */
export function toolResultOf(request: AnthropicRequest): string | undefined {
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

function writeStream(response: ServerResponse, model: string, blocks: Block[], stop: string): void {
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

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const requests: Upstream[] = [];
  let mode: { reply: string } | "fail" = "fail";
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(text) as AnthropicRequest;
    requests.push({ headers: request.headers, body });
    if (mode === "fail") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "proxy test failure" } }));
      return;
    }
    const { blocks, stop } = answer(body, mode.reply);
    if (body.stream) {
      writeStream(response, body.model, blocks, stop);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg_proxy", type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(8090, "0.0.0.0", resolve));
  return {
    requests,
    reply(userId) {
      mode = { reply: userId };
    },
    fail() {
      mode = "fail";
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
