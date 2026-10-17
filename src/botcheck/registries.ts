import type { Id } from "../domain/models.js"
import type { RegistryReason } from "./reasons.js"

export type RegistryName = "cas" | "lols"

export interface RegistryAnswer {
  name: RegistryName
  /** `unknown` when the registry did not answer, refused, or answered something this build cannot read. */
  answer: "listed" | "clean" | "unknown"
  checkedAt: string
  /** Why `unknown`, or what the listing says — never the address asked or a key. */
  detail?: string
  /** The reasons a listing adds to the score. */
  reasons?: RegistryReason[]
}

export interface RegistryOptions {
  fetch?: typeof fetch
  /** Combot's key, where the owner keeps one; CAS answers without one for now. */
  casKey?: string
  now?: () => Date
  timeoutMs?: number
}

/** Where each one is documented, for the help text and the MCP description. */
export const REGISTRIES: Record<RegistryName, { title: string; docs: string }> = {
  cas: { title: "Combot Anti-Spam (CAS)", docs: "https://cas.chat/api" },
  lols: { title: "lols.bot", docs: "https://api.lols.bot/lols-bot.json" },
}

const TIMEOUT_MS = 10_000

/**
 * Asks each registry about one Telegram id, side by side. A registry down or refusing is `unknown`,
 * never an error: the rest of the check still answers. Nothing here may put the request's address
 * in a message — a key could sit in it — so failures are described, not quoted.
 */
export const askRegistries = async (id: Id, options: RegistryOptions = {}): Promise<RegistryAnswer[]> =>
  Promise.all([askCas(id, options), askLols(id, options)])

const getJson = async (
  url: string,
  headers: Record<string, string>,
  { fetch: fetchFn = fetch, timeoutMs = TIMEOUT_MS }: RegistryOptions,
): Promise<{ status: number; body: unknown } | { failed: string }> => {
  try {
    const response = await fetchFn(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
    const text = await response.text()
    try {
      return { status: response.status, body: JSON.parse(text) }
    } catch {
      return { failed: `answered ${response.status} with something that is not JSON` }
    }
  } catch (error) {
    return {
      failed: error instanceof Error && error.name === "TimeoutError" ? "did not answer in time" : "unreachable",
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** `ok: true` with a result is a listing; `ok: false` "Record not found." is clean (seen 2026-10-06). */
export const askCas = async (id: Id, options: RegistryOptions = {}): Promise<RegistryAnswer> => {
  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  const got = await getJson(
    `https://api.cas.chat/check?user_id=${encodeURIComponent(id)}`,
    options.casKey ? { authorization: `Bearer ${options.casKey}` } : {},
    options,
  )
  const unknown = (detail: string): RegistryAnswer => ({ name: "cas", answer: "unknown", checkedAt, detail })
  if ("failed" in got) return unknown(got.failed)
  if (got.status === 401) return unknown(options.casKey ? "refused the key" : "now asks for a key from combot.org")
  const { body } = got
  if (!isObject(body) || typeof body.ok !== "boolean") return unknown("answered in an unexpected shape")
  if (!body.ok) {
    return body.description === "Record not found."
      ? { name: "cas", answer: "clean", checkedAt }
      : unknown(typeof body.description === "string" ? body.description : "refused")
  }
  const result = isObject(body.result) ? body.result : {}
  const offenses = typeof result.offenses === "number" ? result.offenses : undefined
  const since = typeof result.time_added === "string" ? result.time_added : undefined
  return {
    name: "cas",
    answer: "listed",
    checkedAt,
    detail: ["banned", offenses === undefined ? "" : `${offenses} offenses`, since ? `since ${since}` : ""]
      .filter(Boolean)
      .join(", "),
    reasons: ["cas_banned"],
  }
}

/** `banned` and `scammer` per lols.bot's own OpenAPI description. */
export const askLols = async (id: Id, options: RegistryOptions = {}): Promise<RegistryAnswer> => {
  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  const got = await getJson(`https://api.lols.bot/account?id=${encodeURIComponent(id)}`, {}, options)
  const unknown = (detail: string): RegistryAnswer => ({ name: "lols", answer: "unknown", checkedAt, detail })
  if ("failed" in got) return unknown(got.failed)
  const { body } = got
  if (got.status !== 200 || !isObject(body) || body.ok !== true || typeof body.banned !== "boolean") {
    return unknown(`answered ${got.status} in an unexpected shape`)
  }
  const reasons: RegistryReason[] = [
    ...(body.banned ? (["lols_banned"] as const) : []),
    ...(body.scammer === true ? (["lols_scammer"] as const) : []),
  ]
  if (reasons.length === 0) return { name: "lols", answer: "clean", checkedAt }
  const facts = [
    body.banned ? "banned" : "",
    body.scammer === true ? "scammer" : "",
    typeof body.offenses === "number" ? `${body.offenses} offenses` : "",
    typeof body.spam_factor === "number" ? `spam factor ${body.spam_factor}` : "",
    typeof body.when === "string" ? `since ${body.when}` : "",
  ]
  return { name: "lols", answer: "listed", checkedAt, detail: facts.filter(Boolean).join(", "), reasons }
}

/** The registries list Telegram accounts only. */
export const registriesCover = (provider: string): boolean => provider === "telegram"

/** For a messenger the registries do not cover, by its name: every one `unknown`, saying why. */
export const notCovered = (messenger: string, now = new Date()): RegistryAnswer[] =>
  (Object.keys(REGISTRIES) as RegistryName[]).map((name) => ({
    name,
    answer: "unknown",
    checkedAt: now.toISOString(),
    detail: `lists Telegram accounts only, not ${messenger} ones`,
  }))
