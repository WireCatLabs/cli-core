import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_LINK_CONFIG, type LinkConfig, type LinkForm, linkFor } from "../../domain/links.js"
import { safeLiquid } from "../../render/liquid.js"
import { TELEGRAM_TEXT_CHARS } from "../deliver.js"
import type { GapsView, MessageKind, NoticeView } from "./messages.js"
import { parseReport, reportDocument } from "./schema.js"
import { type ReportView, reportView } from "./view.js"

export const REPORT_CHANNELS = ["telegram", "email", "text"] as const
export type ReportChannel = (typeof REPORT_CHANNELS)[number]

/** What a template renders: the digest's view, the weekly gaps' or a failed schedule's notice. */
export type MessageView = ReportView | GapsView | NoticeView

const DEFAULT_LANGUAGE = "en"
const LIMITS = { parse: 65_536, memory: 4_000_000, milliseconds: 1_000 }

export const REPORT_REASONS = {
  invalid: "delivery.report-invalid",
  dropped: "report.items-dropped",
  templateFailed: "report.template-failed",
  templateTags: "report.template-tags",
} as const

const templateFile = (kind: string, channel: ReportChannel, language: string) =>
  fileURLToPath(new URL(`./templates/${kind}.${channel}.${language}.liquid`, import.meta.url))

/** The template shipped with cli-core for that report kind and channel, in `language` or else in English. */
export const defaultTemplate = (kind: string, channel: ReportChannel, language: string): string => {
  const file = templateFile(kind, channel, language)
  return readFileSync(existsSync(file) ? file : templateFile(kind, channel, DEFAULT_LANGUAGE), "utf8")
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (one) => ESCAPES[one] as string)

const escapedDeep = (value: unknown): unknown =>
  typeof value === "string"
    ? escapeHtml(value)
    : Array.isArray(value)
      ? value.map(escapedDeep)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, escapedDeep(one)]))
        : value

const ALLOWED: Record<Exclude<ReportChannel, "text">, Record<string, readonly string[]>> = {
  telegram: { b: [], i: [], a: ["href"] },
  email: {
    div: ["style"],
    p: ["style"],
    b: ["style"],
    i: ["style"],
    a: ["href", "style"],
    br: [],
    span: ["style"],
  },
}

/** Every link URL anywhere in the view: the only places a template's `href` may point. */
const linkUrls = (view: MessageView): Set<string> => {
  const urls = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === "object") {
      const { kind, url, label } = value as Record<string, unknown>
      if ((kind === "open" || kind === "web") && typeof url === "string" && typeof label === "string") urls.add(url)
      else Object.values(value).forEach(walk)
    }
  }
  walk(view)
  return urls
}

/**
 * What a template's HTML may keep, enforced after it rendered: the channel's tags and attributes only, a `style`
 * with no `url(`, and an `href` only to a URL of the view model. Anything else goes, its text kept; `removed` names
 * what went, once per occurrence, and `changed` counts it.
 */
export const sanitizeHtml = (
  channel: Exclude<ReportChannel, "text">,
  html: string,
  urls: ReadonlySet<string>,
): { html: string; changed: number; removed: string[] } => {
  const allowed = ALLOWED[channel]
  const removed: string[] = []
  const dropped: boolean[] = []
  const withoutBlocks = html.replace(/<(script|style|iframe|object)\b[\s\S]*?(<\/\1\s*>|$)/gi, (_, name) => {
    removed.push(`<${String(name).toLowerCase()}> and its content`)
    return ""
  })
  const out = withoutBlocks.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>|[<>]/g, (tag, close, name, rest) => {
    if (name === undefined) {
      removed.push(`a bare ${tag}`)
      return escapeHtml(tag)
    }
    const lower = String(name).toLowerCase()
    const attributes = allowed[lower]
    if (close) {
      if (lower === "a" && dropped.pop()) return ""
      if (!attributes) removed.push(`</${lower}>`)
      return attributes ? `</${lower}>` : ""
    }
    if (!attributes) {
      removed.push(`<${lower}>`)
      return ""
    }
    const kept: string[] = []
    const all = [...String(rest).matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)]
    if (all.length !== (String(rest).match(/=/g)?.length ?? 0)) removed.push(`an unquoted attribute on <${lower}>`)
    for (const [, key = "", value = ""] of all) {
      const attribute = key.toLowerCase()
      const unescaped = value.replace(/&amp;/g, "&")
      if (!attributes.includes(attribute)) removed.push(`${attribute} on <${lower}>`)
      else if (attribute === "href" && !urls.has(unescaped)) removed.push(`an href that is not a link of the report`)
      else if (attribute === "style" && /url\(|expression\(|javascript:/i.test(value))
        removed.push(`a style with url(), expression() or javascript:`)
      else kept.push(`${attribute}="${value}"`)
    }
    if (lower === "a") {
      const linked = kept.some((one) => one.startsWith("href="))
      dropped.push(!linked)
      if (!linked) return ""
    }
    return `<${lower}${kept.map((one) => ` ${one}`).join("")}>`
  })
  return { html: out, changed: removed.length, removed }
}

export interface Rendering {
  /** The parts joined by a blank line: the whole text everywhere but a Telegram digest split in several messages. */
  text: string
  /** Telegram's messages in order, each within its limit; one part on every other channel. */
  parts: string[]
  /** The override template failed and the default was used. */
  templateFailed: boolean
  /** Tags or attributes the platform rules took out. */
  templateTags: number
}

const renderOnce = async (view: MessageView, channel: ReportChannel, source: string) => {
  const engine = safeLiquid(LIMITS)
  if (channel !== "text")
    // These would turn text an agent wrote back into markup after it was escaped.
    for (const name of ["raw", "url_decode", "base64_decode"]) engine.registerFilter(name, (x) => x)
  const scope = (channel === "text" ? view : escapedDeep(view)) as object
  const rendered = String(await engine.parseAndRender(source, scope)).trim()
  if (!rendered) throw new Error("empty")
  if (channel === "text") return { text: rendered, templateTags: 0, removed: [] as string[] }
  const { html, changed, removed } = sanitizeHtml(channel, rendered, linkUrls(view))
  return { text: html, templateTags: changed, removed }
}

const renderWithFallback = async (
  view: MessageView,
  channel: ReportChannel,
  template: string | undefined,
): Promise<Omit<Rendering, "parts">> => {
  const shipped = () => renderOnce(view, channel, defaultTemplate(view.kind, channel, view.language))
  if (template === undefined) return { ...(await shipped()), templateFailed: false }
  try {
    return { ...(await renderOnce(view, channel, template)), templateFailed: false }
  } catch {
    return { ...(await shipped()), templateFailed: true }
  }
}

const fits = (text: string) => text.length <= TELEGRAM_TEXT_CHARS

/**
 * The items `from` up to `to` of the digest, counted across its sections in order, as one Telegram message: the
 * summary on the first, the sources and the footer on the last, a section's "ещё N" and task links where it ends.
 */
const partOf = (view: ReportView, from: number, to: number, first: boolean, last: boolean): ReportView => {
  let at = 0
  const sections = view.sections.flatMap((section): ReportView["sections"] => {
    const start = at
    at += section.items.length
    const items = section.items.slice(Math.max(from - start, 0), Math.max(to - start, 0))
    if (items.length === 0) return []
    const ends = to >= at
    return [{ ...section, items, continued: from > start, ...(ends ? {} : { more: 0, groups: [], undated: null }) }]
  })
  return {
    ...view,
    sections,
    summary: first ? view.summary : null,
    health: last ? view.health : { ...view.health, items: [], more: 0 },
    scope: last ? view.scope : null,
    continued: !first,
  }
}

/**
 * A digest too long for one Telegram message as several, each rendered whole by the template, so every part's markup
 * is complete and no item is cut. A section moves to the next message whole when it would fit there, and is split
 * between items only when it fills a message by itself. Undefined when a single item cannot fit a message.
 */
const digestParts = async (
  view: ReportView,
  render: (part: ReportView) => Promise<string>,
): Promise<string[] | undefined> => {
  const ends: number[] = []
  for (const section of view.sections) ends.push((ends.at(-1) ?? 0) + section.items.length)
  const total = ends.at(-1) ?? 0
  const starts = new Set([0, ...ends])
  const endOf = (item: number) => ends.find((end) => end > item) ?? total
  const parts: string[] = []
  for (let from = 0; ; ) {
    const first = parts.length === 0
    const rest = await render(partOf(view, from, total, first, true))
    if (fits(rest)) return [...parts, rest]
    let to = from
    let kept: string | undefined
    while (to < total) {
      if (to > from && starts.has(to)) {
        const whole = await render(partOf(view, from, endOf(to), first, false))
        if (fits(whole)) {
          kept = whole
          to = endOf(to)
          continue
        }
        if (fits(await render(partOf(view, to, endOf(to), false, false)))) break
      }
      const text = await render(partOf(view, from, to + 1, first, false))
      if (!fits(text)) break
      kept = text
      to += 1
    }
    if (kept === undefined) return undefined
    parts.push(kept)
    from = to
  }
}

/**
 * The view with one item fewer: the digest's last item of its largest section, the last gap; counted in `more`.
 * A notice has nothing to drop.
 */
const dropOne = (view: MessageView): MessageView | undefined => {
  if (view.kind === "schedule-failed") return undefined
  if (view.kind === "weekly-gaps")
    return view.items.length === 0 ? undefined : { ...view, items: view.items.slice(0, -1), more: view.more + 1 }
  const lists = [...view.sections.map((section) => section.items.length), view.health.items.length]
  const largest = lists.reduce((most, one) => Math.max(most, one), 0)
  if (largest === 0) return undefined
  const at = lists.lastIndexOf(largest)
  if (at === view.sections.length)
    return {
      ...view,
      health: { ...view.health, items: view.health.items.slice(0, -1), more: view.health.more + 1 },
    }
  return {
    ...view,
    sections: view.sections.map((section, s) =>
      s === at ? { ...section, items: section.items.slice(0, -1), more: section.more + 1 } : section,
    ),
  }
}

/**
 * One channel's text of a report. A failing `template` (a stored override, later) falls back to the shipped one for
 * this channel only. A digest too long for one Telegram message is split into several (`digestParts`); any other
 * Telegram text, or a digest whose single item cannot fit, is rendered again with an item fewer until it fits.
 */
export const renderReport = async (
  view: MessageView,
  channel: ReportChannel,
  { template }: { template?: string } = {},
): Promise<Rendering> => {
  const whole = await renderWithFallback(view, channel, template)
  if (channel !== "telegram" || fits(whole.text)) return { ...whole, parts: [whole.text] }
  if (view.kind === "morning-digest") {
    const split = (source: string) => digestParts(view, async (part) => (await renderOnce(part, channel, source)).text)
    const shipped = defaultTemplate(view.kind, channel, view.language)
    let failed = whole.templateFailed
    const parts = await (failed || template === undefined ? split(shipped) : split(template)).catch(() => {
      failed = true
      return split(shipped)
    })
    if (parts) return { text: parts.join("\n\n"), parts, templateFailed: failed, templateTags: whole.templateTags }
  }
  let current = view
  let source = template
  for (;;) {
    const rendering = await renderWithFallback(current, channel, source)
    if (rendering.templateFailed) source = undefined
    const smaller = fits(rendering.text) ? undefined : dropOne(current)
    if (!smaller)
      return { ...rendering, parts: [rendering.text], templateFailed: rendering.templateFailed || source !== template }
    current = smaller
  }
}

/**
 * Why `source` may not be saved for this view, empty when it may, and what it renders: it must render, the platform
 * rules may take nothing out, and a Telegram text must fit in its messages, split or once the size fit dropped what
 * it could. Unlike `renderReport` it never falls back to the shipped template.
 */
export const checkTemplate = async (
  view: MessageView,
  channel: ReportChannel,
  source: string,
): Promise<{ problems: string[]; text: string }> => {
  let current = view
  for (;;) {
    let rendering: Awaited<ReturnType<typeof renderOnce>>
    try {
      rendering = await renderOnce(current, channel, source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { problems: [message === "empty" ? "it renders nothing" : `it does not render: ${message}`], text: "" }
    }
    if (rendering.removed.length > 0)
      return {
        problems: [...new Set(rendering.removed)].map((what) => `the ${channel} rules would remove ${what}`),
        text: rendering.text,
      }
    if (channel !== "telegram" || fits(rendering.text)) return { problems: [], text: rendering.text }
    if (current === view && current.kind === "morning-digest") {
      const parts = await digestParts(current, async (part) => (await renderOnce(part, channel, source)).text).catch(
        () => undefined,
      )
      if (parts) return { problems: [], text: parts.join("\n\n") }
    }
    const smaller = dropOne(current)
    if (!smaller)
      return {
        problems: [
          `it is ${rendering.text.length} characters with every item left out; Telegram takes ${TELEGRAM_TEXT_CHARS}`,
        ],
        text: rendering.text,
      }
    current = smaller
  }
}

/** The owner's stored templates of one report kind and language, by channel; a missing channel uses the shipped one. */
export type StoredTemplates = (kind: MessageKind, language: string) => Promise<Partial<Record<ReportChannel, string>>>

/** What `last.json` keeps of a report run, beside the deliveries. */
export interface ReportRun {
  language: string
  /** Store references, backticks, flags and snake_case words taken out of the agent's text. */
  leaks: number
  /** The path of the first field that failed the check; nothing was shown. */
  invalid?: string
  /** The sections, items and health entries left out because they failed the check; the rest was shown. */
  dropped?: string[]
  reasons?: string[]
}

export interface PreparedReport {
  /** The Telegram messages, sent in this order. */
  telegram: string[]
  /** HTML with inline CSS for `mail messages send --html`; absent for an invalid report, which goes as `text`. */
  email?: string
  /** Plain text with web links: the email when the installed mail cannot send `--html`. */
  text: string
  /** Plain text with app links (`wirecat://`), which a desktop terminal opens: `latest.txt`. */
  terminal: string
  /** The checked `wirecat.report/1` document as JSON, for `<run>.report.json`; absent for an invalid one. */
  document?: string
  subject: string
  /** The desktop notice: the title line and the summary. */
  notice: string
  invalid: boolean
  run: ReportRun
}

const INVALID_LINES: Record<string, string> = {
  ru: "Сводка не собралась: ошибка формата. Подробности в WireCat.",
  en: "The report could not be built: format error. Details in WireCat.",
}

const DROPPED_LINES: Record<string, (count: number) => string> = {
  ru: (count) => `⚠️ Не показано из-за ошибки формата: ${count}. Подробности в WireCat.`,
  en: (count) => `⚠️ Left out for a format error: ${count}. Details in WireCat.`,
}

/** The line after a report that lost parts to the check, so a short digest is never read as a whole one. */
const withDropped = (
  rendered: { telegram: string[]; email: string; text: string; terminal: string },
  line: string | undefined,
) => {
  if (!line) return rendered
  const last = rendered.telegram.at(-1) ?? ""
  const note = escapeHtml(line)
  const joined = last ? `${last}\n\n${note}` : note
  const telegram = fits(joined) ? [...rendered.telegram.slice(0, -1), joined] : [...rendered.telegram, note]
  const paragraph = `<p>${note}</p>`
  const email = rendered.email.trimEnd().endsWith("</div>")
    ? rendered.email.replace(/<\/div>\s*$/, `${paragraph}\n</div>`)
    : `${rendered.email}${paragraph}`
  return { telegram, email, text: `${rendered.text}\n\n${line}`, terminal: `${rendered.terminal}\n\n${line}` }
}

/**
 * A run's answer rendered for every route, or `undefined` when it is not a report. An invalid report becomes one
 * line in the owner's language and is never shown raw.
 */
export const prepareReport = async (
  answer: string,
  {
    language,
    now,
    timeZone,
    templates: storedTemplates,
    links = DEFAULT_LINK_CONFIG,
    env = process.env,
    trusted = false,
  }: {
    language: string
    now: number
    timeZone?: string
    /** A lookup that fails delivers with the shipped templates and records `report.template-failed`. */
    templates?: StoredTemplates
    links?: LinkConfig
    /** Read for `WIRECAT_LINKS=off`. */
    env?: NodeJS.ProcessEnv
    /** A command's document, built from the store rather than written by an agent (`parseReport`). */
    trusted?: boolean
  },
): Promise<PreparedReport | undefined> => {
  const parsed = parseReport(answer, trusted)
  if (!parsed) return undefined
  if ("invalid" in parsed) {
    const line = INVALID_LINES[language] ?? (INVALID_LINES[DEFAULT_LANGUAGE] as string)
    return {
      telegram: [escapeHtml(line)],
      text: line,
      terminal: line,
      subject: line,
      notice: line,
      invalid: true,
      run: { language, leaks: 0, invalid: parsed.invalid, reasons: [REPORT_REASONS.invalid] },
    }
  }
  const shipped = existsSync(templateFile(parsed.report.kind, "telegram", language)) ? language : DEFAULT_LANGUAGE
  const viewFor = (form: LinkForm) =>
    reportView(parsed.report, {
      language: shipped,
      now,
      ...(timeZone ? { timeZone } : {}),
      linkOf: (ref) => linkFor(ref, { form, config: links, env }),
    })
  let lookupFailed = false
  const templates = storedTemplates
    ? await storedTemplates(parsed.report.kind, shipped).catch(() => {
        lookupFailed = true
        return {}
      })
    : {}
  const web = viewFor("web")
  const telegram = await renderReport(web, "telegram", templateOf(templates, "telegram"))
  const email = await renderReport(web, "email", templateOf(templates, "email"))
  const text = await renderReport(web, "text", templateOf(templates, "text"))
  const terminal = await renderReport(viewFor("app"), "text", templateOf(templates, "text"))
  const renderings = [telegram, email, text, terminal]
  const reasons: string[] = [
    ...(lookupFailed || renderings.some((one) => one.templateFailed) ? [REPORT_REASONS.templateFailed] : []),
    ...(renderings.some((one) => one.templateTags > 0) ? [REPORT_REASONS.templateTags] : []),
  ]
  const title = text.text.split("\n")[0] ?? ""
  const { dropped } = parsed
  if (dropped.length) reasons.push(REPORT_REASONS.dropped)
  const lineOf = DROPPED_LINES[shipped] ?? (DROPPED_LINES[DEFAULT_LANGUAGE] as (count: number) => string)
  const shown = withDropped(
    { telegram: telegram.parts, email: email.text, text: text.text, terminal: terminal.text },
    dropped.length ? lineOf(dropped.length) : undefined,
  )
  return {
    ...shown,
    document: `${JSON.stringify(reportDocument(parsed.report), null, 2)}\n`,
    subject: title,
    notice: [title, parsed.report.summary].filter(Boolean).join("\n"),
    invalid: false,
    run: {
      language: shipped,
      leaks: parsed.leaks,
      ...(dropped.length ? { dropped } : {}),
      ...(reasons.length ? { reasons } : {}),
    },
  }
}

const templateOf = (templates: Partial<Record<ReportChannel, string>>, channel: ReportChannel) => {
  const template = templates[channel]
  return template === undefined ? {} : { template }
}

/** A message other than the digest, rendered for every channel: what `deliver` sends as a rendered parcel. */
export interface PreparedMessage {
  /** One Telegram message: a notice or the gaps are fitted to one by leaving the last gaps out. */
  telegram: string
  email: string
  text: string
  /** The text's first line. */
  subject: string
  invalid: false
  language: string
  /** `report.template-failed`, `report.template-tags`: as a report run records them. */
  reasons: string[]
}

/**
 * Renders `kind` in the owner's language, or in English when cli-core ships no template in it, over the owner's
 * stored templates; a lookup or a template that fails falls back to the shipped one, as a report's does.
 */
export const prepareMessage = async (
  kind: MessageKind,
  viewOf: (language: string) => MessageView,
  { language, templates: storedTemplates }: { language: string; templates?: StoredTemplates },
): Promise<PreparedMessage> => {
  const shipped = existsSync(templateFile(kind, "telegram", language)) ? language : DEFAULT_LANGUAGE
  let lookupFailed = false
  const templates = storedTemplates
    ? await storedTemplates(kind, shipped).catch(() => {
        lookupFailed = true
        return {}
      })
    : {}
  const view = viewOf(shipped)
  const telegram = await renderReport(view, "telegram", templateOf(templates, "telegram"))
  const email = await renderReport(view, "email", templateOf(templates, "email"))
  const text = await renderReport(view, "text", templateOf(templates, "text"))
  const renderings = [telegram, email, text]
  return {
    telegram: telegram.text,
    email: email.text,
    text: text.text,
    subject: text.text.split("\n")[0] ?? "",
    invalid: false,
    language: shipped,
    reasons: [
      ...(lookupFailed || renderings.some((one) => one.templateFailed) ? [REPORT_REASONS.templateFailed] : []),
      ...(renderings.some((one) => one.templateTags > 0) ? [REPORT_REASONS.templateTags] : []),
    ],
  }
}
