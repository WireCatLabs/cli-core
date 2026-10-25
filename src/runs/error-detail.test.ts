import { homedir } from "node:os"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { endpointTemplate, errorDetailOf, framesOf, redactText } from "./error-detail.js"

describe("endpointTemplate", () => {
  it("keeps the host and the path's words, and drops ids, tokens and the query", () => {
    expect(endpointTemplate("https://api.telegram.org/bot123456:AAH-abcdefghijklmnopqrstuvwxyz/sendMessage")).toBe(
      "https://api.telegram.org/:token/sendMessage",
    )
    expect(endpointTemplate("https://user:pw@botapi.max.ru/chats/-71234567/messages?access_token=s3cret#x")).toBe(
      "https://botapi.max.ru/chats/:id/messages",
    )
    expect(endpointTemplate("/v21.0/104837261/messages")).toBe("/v21.0/:id/messages")
    expect(endpointTemplate("/chats/{chatId}/pin")).toBe("/chats/{chatId}/pin")
    expect(endpointTemplate("/files/Мой%20отчёт.pdf")).toBe("/files/:value")
  })
})

describe("redactText", () => {
  it("masks quotes, emails, phones, tokens, queries and the home directory", () => {
    expect(redactText('no chat named "Mom" for anna@example.com')).toBe('no chat named "[redacted]" for [email]')
    expect(redactText("call +7 916 123-45-67 or 79161234567, chat -1001234567890")).toBe(
      "call [number] or [number], chat -1001234567890",
    )
    expect(redactText("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [redacted]")
    expect(redactText("GET https://x.io/a?token=1&b=2 failed")).toBe("GET https://x.io/a?[redacted] failed")
    expect(redactText(`ENOENT: ${homedir()}/notes/x.md`)).toBe("ENOENT: ~/notes/x.md")
  })
})

describe("errorDetailOf", () => {
  it("reports an MTProto refusal by its key and code", () => {
    const error = new CliError("rate_limited", "Telegram asks to wait 30 s before the next request", {
      provider_error: "FLOOD_WAIT",
      status: 420,
      operation: "messages.sendMessage",
    })
    expect(errorDetailOf(error)).toMatchObject({
      class: "CliError",
      code: "rate_limited",
      operation: "messages.sendMessage",
      provider: { key: "FLOOD_WAIT", code: 420 },
    })
    expect(errorDetailOf(error)).not.toHaveProperty("http")
  })

  it("takes where the call went from the refused response when the error does not say", () => {
    const detail = errorDetailOf(new CliError("rate_limited", "too many requests"), {
      event: "response",
      operation: "messages.send",
      method: "POST",
      endpointTemplate: "/messages",
      status: 429,
      outcome: "error",
    })
    expect(detail).toMatchObject({
      operation: "messages.send",
      http: { method: "POST", endpoint_template: "/messages", status: 429 },
    })
  })

  it("names a crash by its class and node's code, with its cause chain", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" })
    const detail = errorDetailOf(new TypeError("fetch failed", { cause: root }))
    expect(detail).toMatchObject({
      class: "TypeError",
      message: "fetch failed",
      causes: [{ class: "Error", message: "connect ECONNREFUSED 127.0.0.1:443" }],
    })
    expect(errorDetailOf(root).code).toBe("ECONNREFUSED")
  })
})

describe("framesOf", () => {
  it("cuts a path to the package's own and leaves node's internals out", () => {
    const error = new Error("x")
    error.stack = [
      "Error: x",
      `    at send (${homedir()}/.local/share/pnpm/global/5/node_modules/@wirecat/max-cli/dist/client/request.js:42:7)`,
      "    at async run (file:///opt/app/dist/cli/program.js:600:3)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      "    at /srv/app/src/runs/run.ts:12:1",
    ].join("\n")
    expect(framesOf(error)).toEqual([
      "send @wirecat/max-cli/client/request.js:42",
      "run cli/program.js:600",
      "<anonymous> runs/run.ts:12",
    ])
  })
})
