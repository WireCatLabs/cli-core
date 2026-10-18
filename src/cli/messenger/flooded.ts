import { CliError } from "@wirecat/cli-base"
import { isCliFailure } from "../../errors/failures.js"
import { type AccountStanding, type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import { providerErrorKey } from "../../runs/events.js"
import { type FloodMemory, holdEnd, type SendBlock } from "../../sends/flood.js"
import type { Pacer } from "../../sends/pace.js"

const LONG_LIVED = new Set(["self", "newSendId", "close", "formatMarkdown", "formatHtml"])
/** Neither held nor paced, as they listen for as long as the run does; what ends them is still remembered. */
const LISTENING = new Set(["watch", "feed", "listen", "listenHistory"])
const BLOCKING = new Set<AccountStanding["state"]>(["frozen", "limited", "banned"])
/** Shorter waits for the pace pass unannounced; a person at a terminal would not notice them. */
const ANNOUNCE_WAIT_MS = 5_000
/** Longer than this the pace refuses instead of waiting, as a run already ends at a wait this long. */
const LONGEST_PACE_WAIT_MS = 5 * 60_000

const chatOf = (args: unknown[]): string | undefined =>
  typeof args[0] === "string" && /^-?\d+$/.test(args[0]) ? args[0] : undefined

/**
 * The adapter, refusing a call the messenger already said to hold off on, before it is asked again;
 * remembering each new "wait" it answers; and stopping writes once it says the account may not write.
 * Never repeats a call: a send is the caller's to repeat, with its own send id. With a `pacer`, every call also
 * waits for its turn in the profile's pace, and a wait the messenger asks for holds the whole profile.
 */
export const flooded = (
  messenger: MessengerAdapter,
  memory: FloodMemory,
  { name, warn, pacer }: { name: string; warn: (message: string) => void; pacer?: Pacer },
): MessengerAdapter => {
  const kept = async (what: () => void | Promise<void>) => {
    try {
      await what()
    } catch (error) {
      warn(`could not remember ${name}'s wait (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const noted = async (operation: string, chatId: string | undefined, error: unknown) => {
    if (!isCliFailure(error)) return
    const details = error.details ?? {}
    const standing = details.standing as AccountStanding | undefined
    if (standing && BLOCKING.has(standing.state)) {
      await kept(() => {
        const block = memory.block({
          state: standing.state as SendBlock["state"],
          hint: standing.hint ?? error.message,
          ...(standing.until ? { until: standing.until } : {}),
        })
        warn(`writes from this profile are held ${holdEnd(block)}: ${block.hint}`)
      })
      return
    }
    const waitMs = Number(details.retry_after_ms)
    if (error.code !== "rate_limited" || details.remembered === true || !Number.isFinite(waitMs) || waitMs <= 0) return
    const providerError = providerErrorKey(details.provider_error)
    await kept(() => {
      const deadline = memory.remember({
        operation,
        ...(chatId ? { chatId } : {}),
        ...(providerError ? { providerError } : {}),
        waitMs,
      })
      warn(`${name} asked to wait before ${operation} again — until ${deadline.until}`)
    })
    if (pacer) await kept(() => pacer.holdFor(waitMs))
  }

  const turn = async () => {
    if (!pacer) return
    let at = Date.now()
    await kept(async () => {
      at = await pacer.reserve()
    })
    const waitMs = at - Date.now()
    if (waitMs <= 0) return
    if (waitMs > LONGEST_PACE_WAIT_MS) {
      throw new CliError(
        "rate_limited",
        `${name} asked this profile to wait, ${Math.ceil(waitMs / 1000)} s are left — nothing was sent to ${name}`,
        { retry_after_ms: waitMs, retry_at: new Date(at).toISOString(), remembered: true },
      )
    }
    if (waitMs >= ANNOUNCE_WAIT_MS)
      warn(`waiting ${Math.ceil(waitMs / 1000)} s to keep this profile's pace with ${name}`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  return throughWrapper(messenger, {} as MessengerAdapter, (operation, call) => {
    if (LONG_LIVED.has(operation)) return call as never
    if (LISTENING.has(operation))
      return (async (...args: unknown[]) => {
        try {
          return await call(...args)
        } catch (error) {
          await noted(operation, undefined, error)
          throw error
        }
      }) as never
    return (async (...args: unknown[]) => {
      const chatId = chatOf(args)
      const owed = memory.owed(operation, chatId)
      if (owed) {
        const waitMs = Math.max(0, Date.parse(owed.until) - Date.now())
        throw new CliError(
          "rate_limited",
          `${name} asked to wait before ${operation} again, ${Math.ceil(waitMs / 1000)} s are left — nothing was sent to ${name}`,
          {
            retry_after_ms: waitMs,
            retry_at: owed.until,
            remembered: true,
            ...(owed.providerError ? { provider_error: owed.providerError } : {}),
          },
        )
      }
      await turn()
      try {
        return await call(...args)
      } catch (error) {
        await noted(operation, chatId, error)
        throw error
      }
    }) as never
  })
}
