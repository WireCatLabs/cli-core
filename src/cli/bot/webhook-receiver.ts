import { listen } from "../../http/listen.js"
import type { BotEvent, BotWebhookIntake, BotWebhookRequest } from "./port.js"

/** The local port behind the tunnel; MCP's `--http` has 8765. */
export const WEBHOOK_PORT = 8766
/** Meta sends at most 3 MB in one delivery; anything larger is refused unread. */
export const WEBHOOK_BODY = 3 * 1024 * 1024

const LOCAL = ["localhost", "127.0.0.1"]

export interface WebhookReceiver {
  intake: BotWebhookIntake
  publicUrl: URL
  port: number
  /** Keeps a batch: `true` once it is safe to tell the messenger it arrived. */
  take: (events: BotEvent[]) => Promise<boolean>
  signal: AbortSignal
  /** Where the receiver listens, said once it does. */
  listening: (local: URL) => void
  warn: (message: string) => void
}

const answer = (status: number, body = "") =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })

/**
 * Answers the messenger on 127.0.0.1 until `signal` ends it. A delivery is answered 200 only after
 * `take` kept it: a messenger that pushes retries anything else, so a crash or a full disk loses
 * nothing. Batches are kept one at a time, in the order they arrived.
 */
export const receiveWebhooks = async (receiver: WebhookReceiver): Promise<void> => {
  const { intake, publicUrl, take, warn } = receiver
  const hosts = [publicUrl.host, ...LOCAL.map((host) => `${host}:${receiver.port}`), ...LOCAL]
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = (events: BotEvent[]): Promise<boolean> => {
    const turn = queue.then(() => take(events))
    queue = turn.catch(() => undefined)
    return turn
  }

  const handle = async (incoming: Request): Promise<Response> => {
    // A page in the owner's browser can reach 127.0.0.1 too; only the tunnel and the machine itself may.
    if (!hosts.includes(incoming.headers.get("host") ?? "")) return answer(403, "host not allowed")
    const url = new URL(incoming.url)
    if (url.pathname !== "/") return answer(404, "not found")
    const request: BotWebhookRequest = {
      method: incoming.method,
      url,
      headers: incoming.headers,
      body: new Uint8Array(await incoming.arrayBuffer()),
    }
    if (request.method === "GET") {
      const reply = intake.webhookHandshake(request)
      return reply ? answer(reply.status, reply.body) : answer(404, "not found")
    }
    if (request.method !== "POST") return answer(405, "method not allowed")
    if (!intake.webhookAuthentic(request)) return answer(401, "signature does not match")
    let events: BotEvent[]
    try {
      events = intake.webhookEvents(request)
    } catch {
      return answer(400, "unreadable delivery")
    }
    try {
      return (await inTurn(events)) ? answer(200) : answer(503, "not kept")
    } catch (error) {
      warn(`a delivery was not kept: ${error instanceof Error ? error.message : String(error)}`)
      return answer(503, "not kept")
    }
  }

  const listening = await listen(handle, { host: "127.0.0.1", port: receiver.port, maxBody: WEBHOOK_BODY })
  try {
    receiver.listening(listening.url)
    if (!receiver.signal.aborted)
      await new Promise<void>((resolve) => receiver.signal.addEventListener("abort", () => resolve(), { once: true }))
    await queue
  } finally {
    await listening.close()
  }
}
