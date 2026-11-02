import {
  CliError,
  createRenderer,
  processStreams,
  type Renderer,
  type RenderFormat,
  type Streams,
  singleLine,
} from "@wirecat/cli-base"
import { COMPACT_FLAG } from "@wirecat/cli-base/standards"
import { fieldsOf, projectFields } from "./cli/result-fields.js"
import { atDetail, type Detail } from "./output-detail.js"

export interface OutputOptions {
  json?: boolean
  jsonl?: boolean
  quiet?: boolean
  streams?: Streams
  /** Whether a person is looking. Defaults to whether stdout is a terminal. */
  tty?: boolean
  color?: boolean
  env?: NodeJS.ProcessEnv
  fields?: string
  /** How much of each found message: `brief`, the default or `full` (src/output-detail.ts). */
  hitDetail?: Detail
  /** Takes the answer as an object in place of printing it — an agent's run (`BaseEnvironment.agent`). */
  capture?: (value: unknown) => void
  /** One line per item (WC-OUT-24); anything printed past `renderAnswer` stays JSON. */
  compact?: boolean
}

const refuseCompact = ({ json, jsonl, fields, hitDetail }: OutputOptions): void => {
  const other = jsonl
    ? "--jsonl"
    : fields !== undefined
      ? "--json=…"
      : json
        ? "--json"
        : hitDetail === "brief"
          ? "--brief"
          : ""
  if (other)
    throw new CliError("validation_error", `${COMPACT_FLAG} and ${other} ask for different output — pick one`, {
      reason: "output.conflict",
      param: COMPACT_FLAG,
    })
}

/**
 * One place decides the mode, so no command can disagree with another.
 *
 * `--json` forces machine output; otherwise a terminal gets the pretty renderer and a pipe gets
 * JSON, because a pipe is a script until proven otherwise. `--jsonl` gives one JSON object per line
 * instead. In every machine mode **stdout carries JSON and nothing else** — diagnostics are on stderr in all modes, which is what makes
 * that contract hold by construction rather than by remembering.
 */
export const resolveOutput = ({
  json,
  jsonl,
  quiet,
  streams = processStreams,
  tty,
  color,
  fields,
  hitDetail,
  env = process.env,
  capture,
  compact,
}: OutputOptions = {}) => {
  if (compact) refuseCompact({ json, jsonl, fields, hitDetail })
  const interactive = tty ?? process.stdout.isTTY === true
  const format: RenderFormat = jsonl ? "jsonl" : json || compact || !interactive ? "json" : "pretty"
  const painted = format === "pretty" && (color ?? (env.NO_COLOR === undefined && env.TERM !== "dumb" && !env.CI))
  const printing = createRenderer({ format, color: painted, streams })
  const rendered = capture
    ? { ...printing, result: capture, stream: (items: Iterable<unknown>) => capture([...items]) }
    : printing
  // `--json=<fields>` names exactly what to keep, so it chooses from everything unless a level was asked for too.
  const level = hitDetail ?? (fields === undefined ? "default" : "full")
  const standard =
    format === "pretty"
      ? rendered
      : {
          ...rendered,
          result: (value: unknown) => rendered.result(atDetail(value, level)),
          stream: (items: Iterable<unknown>) => rendered.stream(atDetail([...items], level)),
        }
  const created = standard
  const paths = fields === undefined ? undefined : fieldsOf(fields)
  const renderer =
    format === "pretty"
      ? oneLineFields(created)
      : paths
        ? {
            ...created,
            result: (value: unknown) => created.result(projectFields(value, paths)),
            stream: (items: Iterable<unknown>) => created.stream([...items].map((item) => projectFields(item, paths))),
          }
        : created

  return {
    format,
    color: painted,
    streams,
    renderer: quiet ? silence(renderer) : renderer,
    ...(compact ? { compact: true, full: hitDetail === "full" } : {}),
  }
}

/** Fields a person writes in paragraphs; every other string is a name, a title, an id or a path. */
const MULTI_LINE = new Set(["text", "description"])

/**
 * The pretty renderer keeps a newline inside a cell, which is right for a message and wrong for a
 * title: somebody else's chat title would print a row of its own. Machine output is left alone.
 */
const oneLineFields = (renderer: Renderer): Renderer => ({
  ...renderer,
  result: (value) => renderer.result(oneLine(value)),
  stream: (items) => renderer.stream([...items].map((item) => oneLine(item))),
})

const oneLine = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") return key !== undefined && MULTI_LINE.has(key) ? value : singleLine(value)
  if (Array.isArray(value)) return value.map((item) => oneLine(item, key))
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, oneLine(item, field)]))
  }
  return value
}

/**
 * Everything diagnostic, and **not** `failure`: an exit code says which kind of thing went wrong
 * and nothing about which chat or how long to wait, so silencing the sentence too would leave a
 * script with a number and a person with nothing.
 */
const silence = (renderer: Renderer): Renderer => ({
  ...renderer,
  note: () => {},
  success: () => {},
  warn: () => {},
})
