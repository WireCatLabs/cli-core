import * as v from "valibot"
import { timeLimit } from "../http/time-limit.js"
import { checkedOptions } from "./options.js"
import { EmptyAnswer, type ModelAdapter, messagesFor, systemFor } from "./types.js"

// https://platform.claude.com/docs/en/api/versioning
const API_VERSION = "2026-10-21"

// API version 2026-10-21 refuses temperature, top_p and top_k on every model.
const options = v.strictObject({
  stop_sequences: v.optional(v.array(v.string())),
  thinking: v.optional(v.strictObject({ type: v.picklist(["disabled", "adaptive"]) })),
  output_config: v.optional(
    v.strictObject({
      effort: v.optional(v.picklist(["low", "medium", "high"])),
      format: v.optional(v.strictObject({ type: v.literal("json_schema"), schema: v.record(v.string(), v.unknown()) })),
    }),
  ),
})

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

interface StreamEvent {
  type?: string
  index?: number
  message?: { usage?: Usage }
  content_block?: { type?: string; text?: string }
  delta?: { type?: string; text?: string; stop_reason?: string | null }
  usage?: Usage
}

/** Server-sent events as `{ event, data }`, per the WHATWG event-stream format: CRLF, LF or CR end a line. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder()
  let buffer = ""
  let event = ""
  let data: string[] = []
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end = buffer.search(/\r\n|\r|\n/)
      // A lone CR at the end of a chunk may be half of a CRLF; wait for the next chunk to tell.
      while (end >= 0 && !(buffer[end] === "\r" && end === buffer.length - 1 && !done)) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1))
        if (line === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n") }
          event = ""
          data = []
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":")
          const field = colon < 0 ? line : line.slice(0, colon)
          const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1))
          if (field === "event") event = value
          else if (field === "data") data.push(value)
        }
        end = buffer.search(/\r\n|\r|\n/)
      }
      if (done) return
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export const anthropic: ModelAdapter = {
  images: true,
  baseUrl: "https://api.anthropic.com",
  validate: (given) => checkedOptions("anthropic", options, given),
  complete: async (target, request, checked, apiKey, fetcher) => {
    // Like the SDK, the limit covers the wait for the answer to start, not the stream, which a long answer outlasts.
    const limit = timeLimit(120_000)
    let response: Response
    try {
      response = await fetcher(`${target.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "anthropic-version": API_VERSION,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...checked,
          model: target.model,
          system: systemFor(request),
          messages: [
            ...messagesFor(request),
            ...(request.images === undefined
              ? []
              : [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: request.prompt },
                      ...request.images.map((image) => ({
                        type: "image",
                        source: { type: "base64", media_type: image.mimeType, data: image.data },
                      })),
                    ],
                  },
                ]),
          ],
          max_tokens: request.maxTokens,
          stream: true,
        }),
        signal: limit.signal,
        redirect: "error",
      })
    } finally {
      limit.clear()
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      throw new Error("provider rejected request")
    }
    const texts = new Map<number, string>()
    const usage: Usage = {}
    const keep = (from: Usage | undefined) => {
      // message_delta counts are cumulative and leave out what does not apply: overwrite, never add.
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ] as const)
        if (typeof from?.[key] === "number") usage[key] = from[key]
    }
    let started = false
    let stopped = false
    let stopReason: string | null | undefined
    for await (const sse of serverSentEvents(response.body)) {
      let event: StreamEvent
      try {
        event = JSON.parse(sse.data) as StreamEvent
      } catch {
        throw new Error("unreadable stream event")
      }
      if (sse.event === "error" || event.type === "error") throw new Error("provider failed mid-stream")
      if (event.type === "message_start") {
        started = true
        keep(event.message?.usage)
      } else if (!started) continue
      else if (event.type === "content_block_start" && event.content_block?.type === "text")
        texts.set(event.index ?? 0, event.content_block.text ?? "")
      else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const index = event.index ?? 0
        if (texts.has(index)) texts.set(index, (texts.get(index) ?? "") + (event.delta.text ?? ""))
      } else if (event.type === "message_delta") {
        stopReason = event.delta?.stop_reason
        keep(event.usage)
      } else if (event.type === "message_stop") {
        stopped = true
        break
      }
    }
    if (!stopped || stopReason !== "end_turn") throw new Error("incomplete response")
    const text = [...texts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, one]) => one)
      .join("")
    if (text.trim() === "") throw new EmptyAnswer()
    const input =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    const output = usage.output_tokens ?? 0
    return { text, usage: { input, output }, tokens: input + output }
  },
}
