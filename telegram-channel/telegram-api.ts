// The two Bot API methods this Channel uses, over fetch, and nothing else.

export type TelegramUpdate = {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat: { readonly id: number; readonly type: string };
    readonly from?: { readonly id: number; readonly username?: string };
  };
};

type ApiResponse<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error_code: number;
      readonly description: string;
      readonly parameters?: { readonly retry_after?: number };
    };

export class TelegramApiError extends Error {
  code: number;
  retryAfter: number | undefined;

  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram ${method} answered ${code}: ${description}`);
    this.name = "TelegramApiError";
    this.code = code;
    this.retryAfter = retryAfter;
  }

  // A 4xx other than 429 means the request itself is wrong, and repeating it changes nothing.
  get permanent(): boolean {
    return this.code >= 400 && this.code < 500 && this.code !== 429;
  }
}

export const maxTextLength = 4096;

export function createTelegramApi(token: string, baseUrl = "https://api.telegram.org") {
  const root = `${baseUrl}/bot${token}`;

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${root}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = (await response.json()) as ApiResponse<T>;
    if (!parsed.ok) {
      throw new TelegramApiError(
        method,
        parsed.error_code,
        parsed.description,
        parsed.parameters?.retry_after,
      );
    }
    return parsed.result;
  }

  return {
    // Long poll. The HTTP timeout sits above Telegram's own, so a healthy poll is never cut.
    getUpdates(
      offset: number | undefined,
      timeoutSeconds: number,
      signal: AbortSignal,
    ): Promise<TelegramUpdate[]> {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout((timeoutSeconds + 10) * 1000)]);
      return call("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message"] }, bounded);
    },

    async sendMessage(chatId: string, text: string, signal: AbortSignal): Promise<void> {
      for (const chunk of chunks(text)) {
        await call("sendMessage", { chat_id: chatId, text: chunk }, signal);
      }
    },
  };
}

export type TelegramApi = ReturnType<typeof createTelegramApi>;

// Telegram takes 4096 characters per message. Longer text is cut at the last line break
// before the limit, or at the limit when there is none.
function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxTextLength) {
    const cut = rest.lastIndexOf("\n", maxTextLength);
    const at = cut > 0 ? cut : maxTextLength;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}
