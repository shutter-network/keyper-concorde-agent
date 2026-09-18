// A stand-in for api.telegram.org on localhost: the two methods the Channel calls, scripted.
//
// getUpdates long-polls like the real one: it answers as soon as an update is queued, or with
// an empty list when `timeout` seconds pass. Updates below the client's `offset` are forgotten,
// which is what lets a test replay one by pushing it again. sendMessage records what it was
// given, or refuses with a scripted error for one chat.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TelegramUpdate } from "./telegram-api.ts";

export type SentMessage = { readonly chatId: string; readonly text: string };

export type Refusal = {
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
};

export type FakeBotApi = {
  readonly url: string;
  /** Every sendMessage that was accepted, in order. */
  readonly sent: SentMessage[];
  /** Every sendMessage that was refused by the script, in order. */
  readonly refused: SentMessage[];
  /** Queue an update for the next getUpdates. */
  push(update: TelegramUpdate): void;
  /** Refuse sendMessage to this chat with this error, or stop refusing with `undefined`. */
  refuse(chatId: string, refusal: Refusal | undefined): void;
  /** Answer every getUpdates with this error, or stop with `undefined`. */
  failPolls(refusal: Refusal | undefined): void;
  stop(): Promise<void>;
};

export async function startFakeBotApi(): Promise<FakeBotApi> {
  const queue: TelegramUpdate[] = [];
  const sent: SentMessage[] = [];
  const refused: SentMessage[] = [];
  const refusals = new Map<string, Refusal>();
  let pollFailure: Refusal | undefined;

  const server: Server = createServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
    const method = request.url?.split("/").pop();

    if (method === "getUpdates") {
      if (pollFailure !== undefined) return answerRefusal(response, pollFailure);
      const offset = typeof body.offset === "number" ? body.offset : undefined;
      const timeoutMs = (typeof body.timeout === "number" ? body.timeout : 0) * 1000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (offset !== undefined) {
          for (let i = queue.length - 1; i >= 0; i -= 1) {
            if (queue[i].update_id < offset) queue.splice(i, 1);
          }
        }
        if (queue.length > 0 || Date.now() >= deadline || request.destroyed) break;
        await new Promise((resume) => setTimeout(resume, 10));
      }
      return answerOk(response, [...queue]);
    }

    if (method === "sendMessage") {
      const message = { chatId: String(body.chat_id), text: String(body.text) };
      const refusal = refusals.get(message.chatId);
      if (refusal !== undefined) {
        refused.push(message);
        return answerRefusal(response, refusal);
      }
      sent.push(message);
      return answerOk(response, {
        message_id: sent.length,
        chat: { id: Number(message.chatId), type: "private" },
        text: message.text,
      });
    }

    answerRefusal(response, { code: 404, description: `Not Found: method ${method}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    refused,
    push: (update) => {
      queue.push(update);
    },
    refuse: (chatId, refusal) => {
      if (refusal === undefined) refusals.delete(chatId);
      else refusals.set(chatId, refusal);
    },
    failPolls: (refusal) => {
      pollFailure = refusal;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function answerOk(response: ServerResponse, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

function answerRefusal(response: ServerResponse, refusal: Refusal): void {
  response.writeHead(refusal.code, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ok: false,
      error_code: refusal.code,
      description: refusal.description,
      ...(refusal.retryAfter !== undefined ? { parameters: { retry_after: refusal.retryAfter } } : {}),
    }),
  );
}
