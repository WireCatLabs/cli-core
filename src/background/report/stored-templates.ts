import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { linkFor } from "../../domain/links.js"
import { schedulesDir } from "../schedules.js"
import { checkTemplate, REPORT_CHANNELS, type ReportChannel } from "./render.js"
import { parseReport, type ReportKind } from "./schema.js"
import { type ReportView, reportView } from "./view.js"

/** What an owner's template renders. A key with no `kind` has storage and commands, but nothing renders it yet. */
export const TEMPLATE_KEYS = [
  { key: "report/morning-digest", kind: "morning-digest", about: "the morning digest" },
  { key: "report/weekly-gaps", kind: null, about: "the weekly list of what the digest could not check" },
  { key: "notice/schedule-failed", kind: null, about: "the message sent when a scheduled run fails" },
] as const satisfies readonly { key: string; kind: ReportKind | null; about: string }[]

export type TemplateKey = (typeof TEMPLATE_KEYS)[number]["key"]

export const templateKeyOf = (key: string) => TEMPLATE_KEYS.find((one) => one.key === key)

export const reportKeyOf = (kind: ReportKind): TemplateKey => `report/${kind}`

const TEMPLATES = fileURLToPath(new URL("./templates/", import.meta.url))

/** The languages cli-core ships a template in for `kind`: a stored template in another one would never be used. */
export const shippedLanguages = (kind: ReportKind): string[] =>
  [
    ...new Set(
      readdirSync(TEMPLATES)
        .map(
          (file) => file.match(new RegExp(`^${kind}\\.(?:${REPORT_CHANNELS.join("|")})\\.([a-z]{2})\\.liquid$`))?.[1],
        )
        .filter((one): one is string => one !== undefined),
    ),
  ].sort()

const viewOf = (document: string, language: string, now: number, timeZone?: string): ReportView | undefined => {
  const parsed = parseReport(document)
  if (!parsed || "invalid" in parsed) return undefined
  return reportView(parsed.report, {
    language,
    now,
    ...(timeZone ? { timeZone } : {}),
    linkOf: (ref) => linkFor(ref, { form: "web", env: {} }),
  })
}

/** The synthetic report shipped beside the templates: every section, item type and health reason once. */
export const sampleView = (kind: ReportKind, language: string, now: number): ReportView => {
  const view = viewOf(readFileSync(join(TEMPLATES, `${kind}.sample.json`), "utf8"), language, now)
  if (!view) throw new Error(`the shipped ${kind} sample is not a report`)
  return view
}

/** The newest `<run>.report.json` of `kind` the tool's schedules wrote, or undefined. */
export const lastReport = (state: string, kind: ReportKind): { path: string; document: string } | undefined => {
  const folder = schedulesDir(state)
  if (!existsSync(folder)) return undefined
  const files = readdirSync(folder).flatMap((name) => {
    const runs = join(folder, name, "runs")
    return existsSync(runs)
      ? readdirSync(runs)
          .filter((file) => file.endsWith(".report.json"))
          .map((file) => join(runs, file))
      : []
  })
  for (const path of files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)) {
    const document = readFileSync(path, "utf8")
    const parsed = parseReport(document)
    if (parsed && !("invalid" in parsed) && parsed.report.kind === kind) return { path, document }
  }
  return undefined
}

export interface TemplateCheck {
  /** `sample`, or the path of the last real report. */
  against: string
  problems: string[]
  text: string
}

/**
 * Whether `body` may be saved for one channel: it is rendered against the synthetic sample and against the last real
 * report, when the tool has one, with the platform rules that run at send time. Any problem refuses the save.
 */
export const checkTemplateSave = async ({
  kind,
  channel,
  language,
  body,
  state,
  now,
}: {
  kind: ReportKind
  channel: ReportChannel
  language: string
  body: string
  state: string
  now: number
}): Promise<TemplateCheck[]> => {
  const last = lastReport(state, kind)
  const views: [string, ReportView | undefined][] = [
    ["sample", sampleView(kind, language, now)],
    ...(last ? [[last.path, viewOf(last.document, language, now)] as [string, ReportView | undefined]] : []),
  ]
  return Promise.all(
    views.flatMap(([against, view]) =>
      view ? [checkTemplate(view, channel, body).then((check) => ({ against, ...check }))] : [],
    ),
  )
}

/** The view a preview renders: the last real report when there is one, else the sample. */
export const previewView = (state: string, kind: ReportKind, language: string, now: number) => {
  const last = lastReport(state, kind)
  const view = last && viewOf(last.document, language, now)
  return view ? { against: last.path, view } : { against: "sample", view: sampleView(kind, language, now) }
}
