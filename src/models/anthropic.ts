import Anthropic from "@anthropic-ai/sdk"
import * as v from "valibot"
import { checkedOptions } from "./options.js"
import { type ModelAdapter, messagesFor, systemFor } from "./types.js"

// API version 2026-10-21 refuses temperature, top_p and top_k on every model.
const options = v.strictObject({
  stop_sequences: v.optional(v.array(v.string())),
})

export const anthropic: ModelAdapter = {
  images: true,
  baseUrl: "https://api.anthropic.com",
  validate: (given) => checkedOptions("anthropic", options, given),
  complete: async (target, request, checked, apiKey, fetcher) => {
    const client = new Anthropic({
      apiKey: apiKey ?? "",
      authToken: null,
      fetch: (input, init) => fetcher(input, { ...init, redirect: "error" }),
      baseURL: target.baseUrl,
      maxRetries: 0,
      logLevel: "off",
      timeout: 120_000,
    })
    const response = await client.messages
      .stream({
        ...checked,
        model: target.model,
        system: systemFor(request),
        messages: [
          ...messagesFor(request),
          ...(request.images === undefined
            ? []
            : [
                {
                  role: "user" as const,
                  content: request.images.map((image) => ({
                    type: "image" as const,
                    source: { type: "base64" as const, media_type: image.mimeType, data: image.data },
                  })),
                },
              ]),
        ],
        max_tokens: request.maxTokens,
      })
      .finalMessage()
    if (response.stop_reason !== "end_turn") throw new Error("incomplete response")
    return {
      text: response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      tokens:
        response.usage.input_tokens +
        response.usage.output_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
    }
  },
}
