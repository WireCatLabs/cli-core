import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_LINK_CONFIG, type LinkConfig, type LinkForm, linkFor } from "../../domain/links.js"
import { safeLiquid } from "../../render/liquid.js"
import { TELEGRAM_TEXT_CHARS } from "../deliver.js"
import { parseReport, reportDocument } from "./schema.js"
import { type ReportView, reportView } from "./view.js"

export const REPORT_CHANNELS = ["telegram", "email", "text"] as const
export type ReportChannel = (typeof REPORT_CHANNELS)[number]

const DEFAULT_LANGUAGE = "en"
const LIMITS = { parse: 65_536, memory: 4_000_000, milliseconds: 1_000 }

export const REPORT_REASONS = {
  invalid: "delivery.report-invalid",
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

const linkUrls = (view: ReportView): Set<string> =>
  new Set(
    [
      ...view.links,
      ...view.sections.flatMap((section) => section.items.flatMap((item) => item.links)),
      ...view.sections.flatMap((section) => section.groups.flatMap((group) => (group.link ? [group.link] : []))),
      ...view.health.items.flatMap((item) => item.links),
    ].map((link) => link.url),
  )

/**
 * What a template's HTML may keep, enforced after it rendered: the channel's tags and attributes only, a `style`
 * with no `url(`, and an `href` only to a URL of the view model. Anything else goes, its text kept; `changed` counts
 * what went.
 */
export const sanitizeHtml = (
  channel: Exclude<ReportChannel, "text">,
  html: string,
  urls: ReadonlySet<string>,
): { html: string; changed: number } => {
  const allowed = ALLOWED[channel]
  let changed = 0
  const dropped: boolean[] = []
  const withoutBlocks = html.replace(/<(script|style|iframe|object)\b[\s\S]*?(<\/\1\s*>|$)/gi, () => {
    changed++
    return ""
  })
  const out = withoutBlocks.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>|[<>]/g, (tag, close, name, rest) => {
    if (name === undefined) {
      changed++
      return escapeHtml(tag)
    }
    const lower = String(name).toLowerCase()
    const attributes = allowed[lower]
    if (close) {
      if (lower === "a" && dropped.pop()) return ""
      if (!attributes) changed++
      return attributes ? `</${lower}>` : ""
    }
    if (!attributes) {
      changed++
      return ""
    }
    const kept: string[] = []
    const all = [...String(rest).matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)]
    if (all.length !== (String(rest).match(/=/g)?.length ?? 0)) changed++
    for (const [, key = "", value = ""] of all) {
      const attribute = key.toLowerCase()
      const unescaped = value.replace(/&amp;/g, "&")
      if (!attributes.includes(attribute)) changed++
      else if (attribute === "href" && !urls.has(unescaped)) changed++
      else if (attribute === "style" && /url\(|expression\(|javascript:/i.test(value)) changed++
      else kept.push(`${attribute}="${value}"`)
    }
    if (lower === "a") {
      const linked = kept.some((one) => one.startsWith("href="))
      dropped.push(!linked)
      if (!linked) return ""
    }
    return `<${lower}${kept.map((one) => ` ${one}`).join("")}>`
  })
  return { html: out, changed }
}

export interface Rendering {
  text: string
  /** The override template failed and the default was used. */
  templateFailed: boolean
  /** Tags or attributes the platform rules took out. */
  templateTags: number
}

const renderOnce = async (view: ReportView, channel: ReportChannel, source: string) => {
  const engine = safeLiquid(LIMITS)
  if (channel !== "text")
    // These would turn text an agent wrote back into markup after it was escaped.
    for (const name of ["raw", "url_decode", "base64_decode"]) engine.registerFilter(name, (x) => x)
  const scope = (channel === "text" ? view : escapedDeep(view)) as object
  const rendered = String(await engine.parseAndRender(source, scope)).trim()
  if (!rendered) throw new Error("empty")
  if (channel === "text") return { text: rendered, templateTags: 0 }
  const { html, changed } = sanitizeHtml(channel, rendered, linkUrls(view))
  return { text: html, templateTags: changed }
}

const renderWithFallback = async (
  view: ReportView,
  channel: ReportChannel,
  template: string | undefined,
): Promise<Rendering> => {
  const shipped = () => renderOnce(view, channel, defaultTemplate(view.kind, channel, view.language))
  if (template === undefined) return { ...(await shipped()), templateFailed: false }
  try {
    return { ...(await renderOnce(view, channel, template)), templateFailed: false }
  } catch {
    return { ...(await shipped()), templateFailed: true }
  }
}

/** The view with one item fewer: the last of the largest section, counted in that section's `more`. */
const dropOne = (view: ReportView): ReportView | undefined => {
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
 * this channel only. Telegram is rendered again with an item fewer, from the largest section, until it fits.
 */
export const renderReport = async (
  view: ReportView,
  channel: ReportChannel,
  { template }: { template?: string } = {},
): Promise<Rendering> => {
  let current = view
  let source = template
  for (;;) {
    const rendering = await renderWithFallback(current, channel, source)
    if (rendering.templateFailed) source = undefined
    const smaller = channel === "telegram" && rendering.text.length > TELEGRAM_TEXT_CHARS ? dropOne(current) : undefined
    if (!smaller) return { ...rendering, templateFailed: rendering.templateFailed || source !== template }
    current = smaller
  }
}

/** What `last.json` keeps of a report run, beside the deliveries. */
export interface ReportRun {
  language: string
  /** Store references, backticks, flags and snake_case words taken out of the agent's text. */
  leaks: number
  /** The path of the first field that failed the check; nothing was shown. */
  invalid?: string
  reasons?: string[]
}

export interface PreparedReport {
  telegram: string
  /** Plain text with web links: the email's plain part. */
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
    templates = {},
    links = DEFAULT_LINK_CONFIG,
    env = process.env,
  }: {
    language: string
    now: number
    timeZone?: string
    templates?: Partial<Record<ReportChannel, string>>
    links?: LinkConfig
    /** Read for `WIRECAT_LINKS=off`. */
    env?: NodeJS.ProcessEnv
  },
): Promise<PreparedReport | undefined> => {
  const parsed = parseReport(answer)
  if (!parsed) return undefined
  if ("invalid" in parsed) {
    const line = INVALID_LINES[language] ?? (INVALID_LINES[DEFAULT_LANGUAGE] as string)
    return {
      telegram: escapeHtml(line),
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
  const web = viewFor("web")
  const telegram = await renderReport(web, "telegram", templateOf(templates, "telegram"))
  const text = await renderReport(web, "text", templateOf(templates, "text"))
  const terminal = await renderReport(viewFor("app"), "text", templateOf(templates, "text"))
  const renderings = [telegram, text, terminal]
  const reasons = [
    ...(renderings.some((one) => one.templateFailed) ? [REPORT_REASONS.templateFailed] : []),
    ...(renderings.some((one) => one.templateTags > 0) ? [REPORT_REASONS.templateTags] : []),
  ]
  const title = text.text.split("\n")[0] ?? ""
  return {
    telegram: telegram.text,
    text: text.text,
    terminal: terminal.text,
    document: `${JSON.stringify(reportDocument(parsed.report), null, 2)}\n`,
    subject: title,
    notice: [title, parsed.report.summary].filter(Boolean).join("\n"),
    invalid: false,
    run: { language: shipped, leaks: parsed.leaks, ...(reasons.length ? { reasons } : {}) },
  }
}

const templateOf = (templates: Partial<Record<ReportChannel, string>>, channel: ReportChannel) => {
  const template = templates[channel]
  return template === undefined ? {} : { template }
}
