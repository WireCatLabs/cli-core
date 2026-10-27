import { CliError } from "@wirecat/cli-base"
import type { Provider } from "../domain/models.js"
import { isKind, kindOf, providerNamed } from "../domain/providers.js"

/** `personal` and `bots` split `all`: a bot's account is one whose provider ends in `-bot` (`isBotProvider`). */
export type Source = Provider | "personal" | "bots" | "all"

/** How the store tells a bot's copy from a personal account: `max-bot`, `telegram-bot`. */
export const isBotProvider = (provider: Provider): boolean => provider.endsWith("-bot")

/** Whether an account of `provider` is inside `source`: also a kind (`messages`, `mail`) or a provider's alias (`tg`). */
export const inSource = (source: Source, provider: Provider): boolean =>
  source === "all" ||
  (source === "bots" && isBotProvider(provider)) ||
  (source === "personal" && !isBotProvider(provider)) ||
  source === provider ||
  providerNamed(source)?.name === provider ||
  (isKind(source) && kindOf(provider) === source)

const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}

/**
 * `in:` and `--source` take a messenger the store holds, `personal`, `bots` or `all`, a held provider's alias
 * (`tg`), or the kind `messages` or `mail`; an alias and `mail` come back as the provider they stand for.
 */
export const sourceOf = (name: string, value: string, providers: readonly Provider[]): Source => {
  const sources: Source[] = [...providers, "personal", "bots", "all"]
  const source = value.toLowerCase()
  if (sources.includes(source)) return source
  if (source === "mail") return "email"
  if (source === "messages") return source
  if (isKind(source))
    fail(
      `${name}${source} names ${source}, which a message search does not read — ` +
        `search ${source === "meetings" || source === "events" ? `all --source ${source}` : "notes"} does`,
    )
  const named = providerNamed(source)
  if (named && providers.includes(named.name)) return named.name
  return fail(`${name} takes ${[...sources, "messages", "mail"].join(", ")} — not "${value}"`)
}
