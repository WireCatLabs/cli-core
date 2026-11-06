import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { type ServerSystem, TIMED_OUT } from "./system.js"
import { toTelegramHtml } from "./telegram-html.js"

/**
 * Where a schedule's result goes after the run, by the owner's own CLI: a Telegram bot's message (`tg <profile> bot
 * messages send`) or an email (`mail <profile> messages send`). Only the schedule file names it, so nothing the run
 * printed can move it; the run itself never sends.
 */
export type Route =
  | { kind: "telegram-bot"; profile: string; chat: string }
  | { kind: "email"; profile: string; address: string }

const PROGRAMS = {
  "telegram-bot": { command: "tg", prefix: "TG" },
  email: { command: "mail", prefix: "MAIL" },
} as const

// A chat by its id only: a title can change, or name a second chat, and the report would go there.
const CHAT = /^(-?\d+|user:\d+)$/
// The profile-name rule of src/cli/profile.ts, which this layer may not import.
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ADDRESS = /^[^\s@/,<>"]+@[^\s@/,<>"]+\.[^\s@/,<>"]+$/

export const ROUTE_HELP = "telegram-bot:<profile>/<chat id or user:id>, or email:<profile>/<address>"

export const parseRoute = (text: string): Route => {
  const [, kind = "", profile = "", target = ""] = /^([a-z-]+):([^/]+)\/(.+)$/.exec(text.trim()) ?? []
  const refuse = (why: string) => new CliError("validation_error", `--to ${text}: ${why} — ${ROUTE_HELP}`)
  if (!(kind in PROGRAMS)) throw refuse(kind ? `${kind} is not a route` : "a route is <kind>:<profile>/<where>")
  if (!PROFILE.test(profile)) throw refuse(`"${profile}" is not a profile name`)
  if (kind === "telegram-bot") {
    if (!CHAT.test(target)) throw refuse("a bot writes to a chat id or user:<id>, never a title")
    return { kind, profile, chat: target }
  }
  if (!ADDRESS.test(target)) throw refuse(`"${target}" is not one email address`)
  return { kind: "email", profile, address: target }
}

export const routeText = (route: Route): string =>
  `${route.kind}:${route.profile}/${route.kind === "telegram-bot" ? route.chat : route.address}`

export const DELIVERY_REASONS = {
  readOnly: "delivery.read-only",
  programMissing: "delivery.program-missing",
  routeInvalid: "delivery.route-invalid",
  timeout: "delivery.timeout",
  failed: "delivery.failed",
  htmlFallback: "delivery.html-fallback",
} as const
export type DeliveryReason = (typeof DELIVERY_REASONS)[keyof typeof DELIVERY_REASONS]

/**
 * One route's outcome, kept in `last.json`. `error` is the sending CLI's error code and reason id, never its message.
 * A send that went as plain text because Telegram refused the HTML is `ok` with the `html-fallback` reason.
 */
export interface Delivery {
  to: string
  ok: boolean
  reason?: DeliveryReason
  error?: string
}

/** Telegram's limits, in UTF-16 units as JavaScript counts them: a message's text, and a file's caption. */
export const TELEGRAM_TEXT_CHARS = 4096
export const CAPTION_CHARS = 1024
const DELIVERY_TIMEOUT_MS = 120_000

/** The caption: the title, then the report's first lines as far as they fit, cut where a line ends. */
export const headOf = (title: string, report: string, limit = CAPTION_CHARS): string => {
  const more = "\n… the whole report is in the file"
  const room = limit - title.length - 1
  const text = report.trim()
  if (text.length <= room) return text ? `${title}\n${text}` : title
  const cut = text.slice(0, room - more.length)
  const line = cut.lastIndexOf("\n")
  return `${title}\n${line > room / 2 ? cut.slice(0, line) : cut}${more}`
}

/**
 * `tg` answers a 400 from Telegram, which is what a refused HTML text is, as `validation_error`, and says nothing
 * more exact. Any other code (network_error, outcome_unknown, provider_error…) may mean the message arrived.
 */
const REFUSED_CONTENT = "validation_error"

const codeOf = (stderr: string): string | undefined => {
  for (const line of stderr.split("\n").reverse()) {
    try {
      const { code } = (JSON.parse(line) as { error?: { code?: unknown } }).error ?? {}
      if (typeof code === "string") return code
    } catch {}
  }
}

export interface Parcel {
  title: string
  /** A finished run: its output file, and the name the copy sent along has. */
  file?: { path: string; name: string }
  /** A failed run: one line, no file. */
  line?: string
}

const textOf = (title: string, report: string) => (report.trim() ? `${title}\n${report.trim()}` : title)

/** The same text as Telegram HTML; the length that counts against the limits is this one. */
const htmlOf = (title: string, report: string) => toTelegramHtml(textOf(title, report))

/** The caption as HTML: the head is cut in Markdown, where no tag can be split, and cut shorter until its HTML fits. */
export const htmlHeadOf = (title: string, report: string, limit = CAPTION_CHARS): string => {
  let room = limit
  for (;;) {
    const html = toTelegramHtml(headOf(title, report, room))
    if (html.length <= limit || room <= title.length + 40) return html.slice(0, limit)
    room -= Math.max(html.length - limit, 1)
  }
}

/**
 * The words that send along `route`. A bot sends a report that fits one message as its text, and a longer one as a
 * file with its head as the caption, both as Telegram HTML unless `plain`; mail takes the text on stdin. The text goes
 * after `--`, so a report that starts with a dash stays text.
 */
const argvOf = (
  program: string,
  route: Route,
  title: string,
  report: string,
  copy: string | undefined,
  plain = false,
) => {
  const lead = [program, route.profile, "--json", "--no-input"]
  if (route.kind === "email") return [...lead, "messages", "send", "--to", route.address, "--subject", title]
  const text = plain
    ? copy
      ? headOf(title, report)
      : headOf(title, report, TELEGRAM_TEXT_CHARS)
    : copy
      ? htmlHeadOf(title, report)
      : htmlOf(title, report)
  return [
    ...lead,
    "bot",
    "messages",
    "send",
    ...(copy ? ["--file", copy] : []),
    ...(plain ? [] : ["--html"]),
    "--",
    route.chat,
    text,
  ]
}

/** Hands the parcel to each route's CLI, one after another; a route that fails is recorded and the next one still goes. */
export const deliver = async (
  system: ServerSystem,
  env: NodeJS.ProcessEnv,
  routes: readonly string[],
  parcel: Parcel,
  {
    find,
    errorOf,
    locked,
    timeoutMs = DELIVERY_TIMEOUT_MS,
  }: {
    /** Where a program is on the run's PATH. */
    find: (name: string, env: NodeJS.ProcessEnv) => string | undefined
    /** The one line kept of a failed send's stderr. */
    errorOf: (stderr: string, code: number) => string
    /** The lock the scheduler itself runs under: nothing goes out from a locked run. */
    locked?: string
    timeoutMs?: number
  },
): Promise<Delivery[]> => {
  const failed = (to: string, reason: DeliveryReason, error?: string): Delivery => ({
    to,
    ok: false,
    reason,
    ...(error ? { error } : {}),
  })
  const report = parcel.line ?? (parcel.file ? readFileSync(parcel.file.path, "utf8") : "")
  const out: Delivery[] = []
  for (const to of routes) {
    let route: Route
    try {
      route = parseRoute(to)
    } catch {
      out.push(failed(to, DELIVERY_REASONS.routeInvalid))
      continue
    }
    const { command, prefix } = PROGRAMS[route.kind]
    const lock = locked ?? [`${prefix}_READ_ONLY`].find((name) => env[name] && env[name] !== "0")
    if (lock) {
      out.push(failed(to, DELIVERY_REASONS.readOnly, lock))
      continue
    }
    const program = find(command, env)
    if (!program) {
      out.push(failed(to, DELIVERY_REASONS.programMissing, command))
      continue
    }
    const tooLong = route.kind === "telegram-bot" && htmlOf(parcel.title, report).length > TELEGRAM_TEXT_CHARS
    // The sending CLI refuses its own and the other WireCat folders, where the report lives, so it gets a copy.
    const folder =
      route.kind === "telegram-bot" && parcel.file && tooLong ? mkdtempSync(join(tmpdir(), "wirecat-deliver-")) : ""
    const copy = folder && parcel.file ? join(folder, parcel.file.name) : undefined
    try {
      if (copy && parcel.file) copyFileSync(parcel.file.path, copy)
      const { [`${prefix}_PROFILE`]: _, ...childEnv } = env
      const options = {
        timeoutMs,
        ...(route.kind === "email" ? { input: report.trim() ? report : parcel.title } : {}),
      }
      let ran = await system.run(argvOf(program, route, parcel.title, report, copy), childEnv, options)
      let fellBack = ""
      if (
        route.kind === "telegram-bot" &&
        ran.code !== 0 &&
        ran.code !== TIMED_OUT &&
        codeOf(ran.stderr) === REFUSED_CONTENT
      ) {
        fellBack = errorOf(ran.stderr, ran.code)
        ran = await system.run(argvOf(program, route, parcel.title, report, copy, true), childEnv, options)
      }
      if (ran.code === 0) {
        out.push(fellBack ? { to, ok: true, reason: DELIVERY_REASONS.htmlFallback, error: fellBack } : { to, ok: true })
      } else if (ran.code === TIMED_OUT) out.push(failed(to, DELIVERY_REASONS.timeout))
      else out.push(failed(to, DELIVERY_REASONS.failed, errorOf(ran.stderr, ran.code)))
    } catch {
      out.push(failed(to, DELIVERY_REASONS.failed))
    } finally {
      if (folder) rmSync(folder, { recursive: true, force: true })
    }
  }
  return out
}
