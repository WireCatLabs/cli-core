import * as v from "valibot"
import { withTimeLimit } from "../http/time-limit.js"
import { onThisComputer } from "./endpoint.js"
import { checkedOptions, range } from "./options.js"
import { EmptyAnswer, type ModelAdapter, messagesFor, systemFor } from "./types.js"

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
                    content: [
                      { type: "text", text: request.prompt },
                      ...request.images.map((image) => ({
                        type: "image_url",
                        image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: "high" },
                      })),
                    ],
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
      const content = choice?.message?.content
      const total = body.usage?.total_tokens
      const counted = Number.isInteger(total) && (total ?? 0) >= 1
      // A hosted API always reports why it stopped and what it counted; an answer without them may be cut short,
      // and the count is what the owner pays. Ollama's /v1 leaves both empty on a whole answer from some models.
      const local = onThisComputer(target.baseUrl)
      const finish = choice?.finish_reason ?? null
      if (finish !== "stop" && !(local && finish === null)) throw new Error("incomplete response")
      if (typeof content !== "string" || content.trim() === "") throw new EmptyAnswer()
      if (!counted && !local) throw new Error("incomplete response")
      const { prompt_tokens: input, completion_tokens: output } = body.usage ?? {}
      return {
        text: content,
        // No count from a server on this computer costs nothing; a rough one keeps the gateway's check meaningful.
        tokens: counted ? (total as number) : Math.max(1, Math.ceil(content.length / 4)),
        ...(Number.isInteger(input) && Number.isInteger(output)
          ? { usage: { input: input as number, output: output as number } }
          : {}),
      }
    }),
}
