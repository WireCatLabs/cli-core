import * as v from "valibot"
import { withTimeLimit } from "../http/time-limit.js"
import { checkedOptions, range } from "./options.js"
import { type ModelAdapter, messagesFor, systemFor } from "./types.js"

const options = v.strictObject({
  temperature: range(0, 2),
  top_p: range(0, 1),
  presence_penalty: range(-2, 2),
  frequency_penalty: range(-2, 2),
  seed: v.optional(v.pipe(v.number(), v.integer())),
  stop: v.optional(v.union([v.string(), v.array(v.string())])),
  response_format: v.optional(v.strictObject({ type: v.picklist(["text", "json_object"]) })),
})

export const openai: ModelAdapter = {
  images: true,
  baseUrl: "https://api.openai.com/v1",
  validate: (given) => checkedOptions("openai", options, given),
  complete: (target, request, checked, apiKey, fetcher) =>
    withTimeLimit(120_000, async (deadline) => {
      const response = await fetcher(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          ...checked,
          model: target.model,
          messages: [
            { role: "system", content: systemFor(request) },
            ...messagesFor(request),
            ...(request.images === undefined
              ? []
              : [
                  {
                    role: "user",
                    content: request.images.map((image) => ({
                      type: "image_url",
                      image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: "high" },
                    })),
                  },
                ]),
          ],
          ...(new URL(target.baseUrl).hostname === "api.openai.com"
            ? { max_completion_tokens: request.maxTokens }
            : { max_tokens: request.maxTokens }),
        }),
        signal: deadline,
        redirect: "error",
      })
      if (!response.ok) throw new Error("provider rejected request")
      const body = (await response.json()) as {
        choices?: { finish_reason?: string; message?: { content?: unknown } }[]
        usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number }
      }
      const choice = body.choices?.[0]
      if (
        choice?.finish_reason !== "stop" ||
        typeof choice.message?.content !== "string" ||
        !Number.isInteger(body.usage?.total_tokens) ||
        (body.usage?.total_tokens ?? 0) < 1
      )
        throw new Error("incomplete response")
      const { prompt_tokens: input, completion_tokens: output } = body.usage ?? {}
      return {
        text: choice.message.content,
        tokens: body.usage?.total_tokens as number,
        ...(Number.isInteger(input) && Number.isInteger(output)
          ? { usage: { input: input as number, output: output as number } }
          : {}),
      }
    }),
}
