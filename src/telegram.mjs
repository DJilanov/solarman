import {
  validTelegramToken,
  validTelegramChat,
} from "./notification-secrets.mjs";

/** @typedef {{state:'delivered',code:'delivered',messageId:number}|{state:'rejected'|'unconfirmed'|'retry'|'cancelled',code:string,retryAfter?:number}} DeliveryResult */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {Response} response @returns {Promise<unknown>} */
async function responseBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw new Error("Response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** @param {{botToken:string,chatId:string,text:string,signal?:AbortSignal}} input @param {typeof fetch} [transport] @returns {Promise<DeliveryResult>} */
export async function sendTelegram(input, transport = fetch) {
  if (
    !validTelegramToken(input.botToken) ||
    !validTelegramChat(input.chatId) ||
    typeof input.text !== "string" ||
    input.text.length < 1 ||
    input.text.length > 4096
  )
    return { state: "rejected", code: "invalid_configuration" };
  if (input.signal?.aborted)
    return { state: "cancelled", code: "cancelled_before_dispatch" };
  const deadline = AbortSignal.timeout(10000);
  const signal = input.signal
    ? AbortSignal.any([deadline, input.signal])
    : deadline;
  try {
    const response = await transport(
      `https://api.telegram.org/bot${input.botToken}/sendMessage`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: input.text,
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    const body = await responseBody(response);
    if (!record(body) || typeof body.ok !== "boolean")
      return { state: "unconfirmed", code: "response_unconfirmed" };
    if (body.ok === true) {
      const message = record(body.result) ? body.result : null;
      const chat = record(message?.chat) ? message.chat : null;
      if (
        !response.ok ||
        typeof message?.message_id !== "number" ||
        !Number.isSafeInteger(message.message_id) ||
        message.message_id <= 0 ||
        typeof chat?.id !== "number" ||
        !Number.isSafeInteger(chat.id) ||
        String(chat.id) !== input.chatId
      )
        return { state: "unconfirmed", code: "response_unconfirmed" };
      return {
        state: "delivered",
        code: "delivered",
        messageId: message.message_id,
      };
    }
    const code =
      typeof body.error_code === "number" &&
      Number.isSafeInteger(body.error_code)
        ? body.error_code
        : response.status;
    if (code === 429) {
      const seconds = record(body.parameters)
        ? body.parameters.retry_after
        : null;
      return typeof seconds === "number" &&
        Number.isSafeInteger(seconds) &&
        seconds > 0 &&
        seconds <= 2592000
        ? { state: "retry", code: "rate_limited", retryAfter: seconds }
        : { state: "rejected", code: "rate_limit_delay_unavailable" };
    }
    if (code === 401) return { state: "rejected", code: "bot_unauthorized" };
    if (code === 403 || code === 400)
      return { state: "rejected", code: "destination_rejected" };
    if (code >= 500) return { state: "retry", code: "provider_unavailable" };
    return { state: "rejected", code: "provider_rejected" };
  } catch {
    return {
      state: "unconfirmed",
      code: deadline.aborted ? "delivery_timeout" : "transport_unconfirmed",
    };
  }
}
