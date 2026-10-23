import { createHmac, timingSafeEqual } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { request } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Message } from "../../domain/models.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { botCommand } from "./command.js"
import type { BotAdapter, BotEvent, BotMessenger, BotWebhookRequest } from "./port.js"
import { ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const config = settingsFor(app)
const SECRET = "s3cret-app"
const VERIFY = "s3cret-verify"

let root: string
let env: NodeJS.ProcessEnv
let keyring: ReturnType<typeof memoryKeyring>
let stop: AbortController
let failKeep: number
let kept: (readonly BotEvent[])[]

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

const message = (id: string, text: string): Message => ({
  id,
  chatId: "70000000001",
  senderId: "70000000001",
  senderName: "Ann",
  timestamp: "2026-10-22T10:00:00.000Z",
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

/** Meta's rules, in miniature: the handshake echoes the challenge, the signature is an HMAC of the raw bytes. */
const adapter = (): BotAdapter => ({
  me: async () => ({ id: "bot1", name: "Shop", username: null }),
  close: async () => {},
  webhooks: async () => [{ url: "https://elsewhere.example/", types: null }],
  webhookHandshake: (request: BotWebhookRequest) => {
    const query = request.url.searchParams
    if (query.get("hub.mode") !== "subscribe") return undefined
    return query.get("hub.verify_token") === VERIFY
      ? { status: 200, body: query.get("hub.challenge") ?? "" }
      : { status: 403, body: "verify token does not match" }
  },
  webhookAuthentic: (request: BotWebhookRequest) => {
    const given = Buffer.from(request.headers.get("x-hub-signature-256") ?? "")
    const wanted = Buffer.from(sign(Buffer.from(request.body).toString("utf8")))
    return given.length === wanted.length && timingSafeEqual(given, wanted)
  },
  webhookEvents: (request: BotWebhookRequest) => {
    const { id, text } = JSON.parse(Buffer.from(request.body).toString("utf8")) as { id: string; text: string }
    return [{ event: "message", message: { ...message(id, text), chatTitle: null }, update: { id, kind: "messages" } }]
  },
})

const bot: BotMessenger = {
  app,
  provider: "chat-bot",
  name: "Chat",
  resolveSettings: config.resolveSettings,
  connect: async () => adapter(),
  tokenStore: (_command, profile) =>
    new BotTokenStore({ app, profile, env: {}, configDir: join(root, "config"), keyring }),
  keepUpdates: (_command, _profile, events) => {
    if (failKeep > 0) {
      failKeep -= 1
      throw new Error("disk full")
    }
    kept.push(events)
  },
}

const receiver = async (more: string[] = []) => {
  const port = await freePort()
  const streams = captureStreams()
  const done = run(
    [
      "sales",
      "bot",
      "watch",
      "--jsonl",
      "--public-url",
      "https://shop.example.ts.net",
      "--port",
      String(port),
      ...more,
    ],
    { app, commands: () => [botCommand(bot)] },
    { streams, tty: false, env, signal: stop.signal },
  )
  await vi.waitFor(() => expect(streams.stderr.join("\n")).toContain("receiving at"), { interval: 5 })
  const at = (path = "/") => new URL(path, `http://127.0.0.1:${port}`)
  const deliver = (body: string, signature = sign(body)) =>
    fetch(at(), { method: "POST", body, headers: { "x-hub-signature-256": signature } })
  const end = async () => {
    stop.abort()
    return { code: await done, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
  }
  return { at, deliver, end }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-webhook-"))
  env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
  keyring = memoryKeyring()
  stop = new AbortController()
  failKeep = 0
  kept = []
  new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring }).write("token")
  new ChatRegistry(app, "sales", env).observe([{ id: "70000000001", title: "Ann", kind: "dialog" }])
})

describe("bot watch --public-url", () => {
  it("**answers the subscription handshake** with the challenge, and refuses a wrong verify token", async () => {
    const { at, end } = await receiver()
    const ok = await fetch(at(`/?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`))
    const wrong = await fetch(at("/?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1"))
    const finished = await end()

    expect([ok.status, await ok.text()]).toEqual([200, "1158201444"])
    expect(wrong.status).toBe(403)
    expect(finished.code).toBe(0)
  })

  it("**keeps a signed delivery before answering 200**, prints it, and skips the same update delivered again", async () => {
    const { deliver, end } = await receiver()
    const body = JSON.stringify({ id: "wamid.1", text: "hello" })
    const first = await deliver(body)
    const again = await deliver(body)
    const finished = await end()

    expect([first.status, again.status]).toEqual([200, 200])
    expect(kept).toHaveLength(1)
    expect(finished.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: "wamid.1", text: "hello", chatTitle: "Ann" }),
    ])
  })

  it("**refuses a delivery whose signature does not match**, and keeps nothing from it", async () => {
    const { deliver, end } = await receiver()
    const body = JSON.stringify({ id: "wamid.2", text: "forged" })
    const forged = await deliver(body, sign(body, "not-the-app-secret"))
    const unsigned = await deliver(body, "")
    const finished = await end()

    expect([forged.status, unsigned.status]).toEqual([401, 401])
    expect(kept).toEqual([])
    expect(finished.stdout).toEqual([])
  })

  it("**answers a batch it could not keep with an error**, so the messenger sends it again", async () => {
    failKeep = 1
    const { deliver, end } = await receiver()
    const body = JSON.stringify({ id: "wamid.3", text: "later" })
    const refused = await deliver(body)
    const retried = await deliver(body)
    const finished = await end()

    expect([refused.status, retried.status]).toEqual([503, 200])
    expect(finished.stdout).toHaveLength(1)
  })

  it("**refuses a request for another path, or for a host that is neither the tunnel nor this machine**", async () => {
    const { at, end } = await receiver()
    const elsewhere = await fetch(at("/hook"), { method: "POST", body: "{}" })
    const rebound = await new Promise<number>((resolve, reject) => {
      const sent = request(at(), { method: "POST", headers: { host: "attacker.example" } }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      sent.once("error", reject)
      sent.end("{}")
    })
    await end()

    expect([elsewhere.status, rebound]).toEqual([404, 403])
  })

  it("**refuses an http address that is not this machine** and a --port without --public-url", async () => {
    const streams = captureStreams()
    const insecure = await run(
      ["sales", "bot", "watch", "--jsonl", "--public-url", "http://shop.example.ts.net"],
      { app, commands: () => [botCommand(bot)] },
      { streams, tty: false, env, signal: stop.signal },
    )
    const portOnly = await run(
      ["sales", "bot", "watch", "--jsonl", "--port", "8766"],
      { app, commands: () => [botCommand(bot)] },
      { streams, tty: false, env, signal: stop.signal },
    )

    expect([insecure, portOnly]).toEqual([2, 2])
    expect(streams.stderr.join("\n")).toContain("--public-url must be https")
  })
})

describe("bot auth set --secret", () => {
  const secretive: BotMessenger = {
    ...bot,
    secrets: [{ name: "app-secret", description: "the app secret, from App settings → Basic" }],
    readSecret: async () => "s3cret-typed",
  }
  const call = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(argv, { app, commands: () => [botCommand(secretive)] }, { streams, tty: false, env })
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }

  it("**keeps a named secret beside the token** without printing it, and forgets it with the token", async () => {
    const set = await call(["sales", "bot", "auth", "set", "--secret", "app-secret", "--json"])
    const tokens = new BotTokenStore({ app, profile: "sales", env: {}, configDir: join(root, "config"), keyring })

    expect(set.code).toBe(0)
    expect(JSON.parse(set.stdout).item).toEqual({ profile: "sales", secret: "app-secret", stored: "keyring" })
    expect(set.stdout + set.stderr).not.toContain("s3cret-typed")
    expect(tokens.readSecret("app-secret")?.secret).toBe("s3cret-typed")

    const removed = await call(["sales", "bot", "auth", "remove", "--json"])
    expect(JSON.parse(removed.stdout).item.secrets).toEqual({ "app-secret": ["keyring"] })
    expect(tokens.readSecret("app-secret")).toBeUndefined()
  })

  it("**refuses a secret the messenger does not have**", async () => {
    const refused = await call(["sales", "bot", "auth", "set", "--secret", "password"])

    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain("one of: app-secret")
  })
})
