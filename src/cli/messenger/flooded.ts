import { CliError } from "@wirecat/cli-base"
import { isCliFailure } from "../../errors/failures.js"
import { type AccountStanding, type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import { providerErrorKey, type Warn } from "../../runs/events.js"
import { type FloodMemory, holdEnd, type SendBlock } from "../../sends/flood.js"
import { type Pacer, waitForTurn } from "../../sends/pace.js"

const LONG_LIVED = new Set(["self", "newSendId", "close", "formatMarkdown", "formatHtml", "storedChats"])
/** Neither held nor paced, as they listen for as long as the run does; what ends them is still remembered. */
const LISTENING = new Set(["watch", "feed", "listen", "listenHistory"])
const BLOCKING = new Set<AccountStanding["state"]>(["frozen", "limited", "banned"])

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
  { name, warn, pacer }: { name: string; warn: Warn; pacer?: Pacer },
): MessengerAdapter => {
  const kept = async (operation: string, what: () => void | Promise<void>) => {
    try {
      await what()
    } catch (error) {
      warn(`could not remember ${name}'s wait (${error instanceof Error ? error.message : String(error)})`, {
        event: "warning",
        code: "wait_not_remembered",
        operation,
      })
    }
  }

  const noted = async (operation: string, chatId: string | undefined, error: unknown) => {
    if (!isCliFailure(error)) return
    const details = error.details ?? {}
    const standing = details.standing as AccountStanding | undefined
    if (standing && BLOCKING.has(standing.state)) {
      await kept(operation, () => {
        const block = memory.block({
          state: standing.state as SendBlock["state"],
          hint: standing.hint ?? error.message,
          ...(standing.until ? { until: standing.until } : {}),
        })
        warn(`writes from this profile are held ${holdEnd(block)}: ${block.hint}`, {
          event: "warning",
          code: `account_${block.state}`,
          operation,
        })
      })
      return
    }
    const waitMs = Number(details.retry_after_ms)
    if (error.code !== "rate_limited" || details.remembered === true || !Number.isFinite(waitMs) || waitMs <= 0) return
    const providerError = providerErrorKey(details.provider_error)
    await kept(operation, () => {
      const deadline = memory.remember({
        operation,
        ...(chatId ? { chatId } : {}),
        ...(providerError ? { providerError } : {}),
        waitMs,
      })
      warn(`${name} asked to wait before ${operation} again — until ${deadline.until}`, {
        event: "warning",
        code: "flood_wait",
        operation,
        counts: { seconds: Math.ceil(waitMs / 1000) },
      })
    })
    if (pacer) await kept(operation, () => pacer.holdFor(waitMs))
  }

  const turn = async (operation: string) => {
    if (pacer) await waitForTurn(pacer, { name, operation, warn })
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
      await turn(operation)
      try {
        return await call(...args)
      } catch (error) {
        await noted(operation, chatId, error)
        throw error
      }
    }) as never
  })
}
