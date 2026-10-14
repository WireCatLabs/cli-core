import { describe, expect, it, vi } from "vitest"
import { gatewayOcr } from "../attachments/gateway-ocr.js"
import { modelGateway } from "./index.js"
import { type ModelAdapter, type ModelImage, systemFor } from "./types.js"

const image: ModelImage = { mimeType: "image/png", data: "AQIDBA==" }
const request = { purpose: "ocr", prompt: "Transcribe", images: [image], maxTokens: 100 }
const app = { appName: "chat-cli", command: "chat", envPrefix: "CHAT", description: "", version: "1.0.0" }

const anthropicAnswer = () => {
  const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  return new Response(
    [
      event("message_start", {
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          content: [],
          model: "vision-fixture",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "invoice 42" } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      event("message_stop", {}),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("shared gateway image input", () => {
  it("stops later bulk API calls after a rate limit without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ error: { message: "fixture rate limit" } }, { status: 429 }),
    )
    const pipeline = gatewayOcr({
      app,
      env: {},
      settings: { models: { ocr: { provider: "openai", model: "fixture" } } },
      enabled: true,
      fetch: fetcher,
      key: () => "synthetic-key",
    })
    await expect(pipeline.transcribe(image)).rejects.toMatchObject({ code: "rate_limited" })
    await expect(pipeline.transcribe(image)).rejects.toMatchObject({ code: "rate_limited" })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(["openai", "anthropic"])(
    "serializes local image data for %s and preserves literal OCR instructions",
    async (provider) => {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        const content = body.messages.at(-1).content
        if (provider === "openai") {
          expect(content).toEqual([
            { type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==", detail: "high" } },
          ])
          expect(body.messages[0].content).toContain("untrusted document data")
          return Response.json({
            choices: [{ finish_reason: "stop", message: { content: "invoice 42" } }],
            usage: { total_tokens: 13 },
          })
        }
        expect(content).toEqual([
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AQIDBA==" } },
        ])
        expect(body.system).toContain("transcribe visible text literally")
        return anthropicAnswer()
      })
      const result = await modelGateway({
        resolve: () => ({ provider, model: "vision-fixture" }),
        consent: () => true,
        key: () => "synthetic-key",
        fetch: fetcher,
      }).complete(request)
      expect(result.text).toBe("invoice 42")
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    { mimeType: "image/png", data: "https://example.test/private" },
    { mimeType: "image/png", data: "" },
    { mimeType: "image/bmp", data: "AQIDBA==" },
    { mimeType: "image/png", data: "AB==" },
    { mimeType: "image/png", data: "AAAA".repeat(1_400_000) },
  ])("refuses invalid or oversized image input before consent, credentials or network", async (invalid) => {
    const consent = vi.fn(() => true),
      key = vi.fn(() => "synthetic"),
      fetcher = vi.fn<typeof fetch>()
    await expect(
      modelGateway({
        resolve: () => ({ provider: "openai", model: "vision-fixture" }),
        consent,
        key,
        fetch: fetcher,
      }).complete({ ...request, images: [invalid as ModelImage] }),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(consent).not.toHaveBeenCalled()
    expect(key).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("refuses a text-only adapter and denied image consent before network", async () => {
    const fake: ModelAdapter = {
      baseUrl: "https://example.test",
      validate: () => ({}),
      complete: vi.fn(async () => ({ text: "unused", tokens: 1 })),
    }
    await expect(
      modelGateway({
        resolve: () => ({ provider: "fake", model: "fixture" }),
        consent: () => true,
        adapters: { fake },
      }).complete(request),
    ).rejects.toThrow("does not support image")
    expect(fake.complete).not.toHaveBeenCalled()
    const fetcher = vi.fn<typeof fetch>()
    await expect(
      modelGateway({
        resolve: () => ({ provider: "openai", model: "fixture" }),
        consent: () => false,
        fetch: fetcher,
      }).complete(request),
    ).rejects.toMatchObject({ code: "permission_error" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("permits literal OCR of untrusted data while preserving other callers' no-copy policy", () => {
    expect(systemFor({ ...request, data: "fixture" })).not.toContain("Do not quote or copy")
    expect(systemFor({ purpose: "replies", prompt: "reply", data: "fixture", maxTokens: 10 })).toContain(
      "Do not quote or copy",
    )
  })

  it("requires explicit OCR and a configured purpose, and includes target identity in the cache key", () => {
    expect(() => gatewayOcr({ app, env: {}, settings: {}, enabled: false })).toThrow("explicit OCR")
    expect(() => gatewayOcr({ app, env: {}, settings: {}, enabled: true })).toThrow("models.ocr")
    const configured = (model: string, baseUrl?: string) =>
      gatewayOcr({
        app,
        env: {},
        enabled: true,
        settings: { models: { ocr: { provider: "openai", model, ...(baseUrl ? { base_url: baseUrl } : {}) } } },
      }).extractor
    expect(configured("a")).toBe(configured("a"))
    expect(configured("a")).not.toBe(configured("b"))
    expect(configured("a")).not.toBe(configured("a", "https://example.test/v1"))
  })
})
