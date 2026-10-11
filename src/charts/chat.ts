import { CliError } from "@wirecat/cli-base"
import type { ChatStats } from "../services/chat-stats.js"
import { CHART_KINDS, type ChartData, type ChartKind, type ChartPeriod } from "./model.js"

export const chartKindOf = (value: string): ChartKind => {
  if (!(CHART_KINDS as readonly string[]).includes(value)) {
    throw new CliError("validation_error", `chart kind takes ${CHART_KINDS.join(", ")}`)
  }
  return value as ChartKind
}

export const chartPeriodOf = (value: string): ChartPeriod => {
  if (value !== "day" && value !== "week") throw new CliError("validation_error", "by takes day or week")
  return value
}

const headings = {
  messages: { title: "Messages", name: "Messages", kind: "bar", unit: "messages" },
  active: { title: "Active authors", name: "Authors", kind: "line", unit: "people" },
  membership: { title: "Joins and leaves", name: "Joined", kind: "grouped-bar", unit: "people" },
} as const

const keysBetween = (keys: string[], by: ChartPeriod): string[] => {
  if (keys.length === 0) return []
  const start = new Date(`${keys[0]}T00:00:00Z`)
  const last = keys.at(-1) as string
  const values: string[] = []
  for (let key = start.toISOString().slice(0, 10); key <= last; key = start.toISOString().slice(0, 10)) {
    values.push(key)
    if (values.length > 20_000) throw new CliError("validation_error", "the chart period is too large")
    start.setUTCDate(start.getUTCDate() + (by === "week" ? 7 : 1))
  }
  return values
}

export const chatChart = (
  stats: ChatStats,
  { kind = "messages", by = "day", timezone }: { kind?: ChartKind; by?: ChartPeriod; timezone: string },
): ChartData => {
  if (kind === "membership" && stats.members === undefined) {
    throw new CliError("validation_error", "joins and leaves are unavailable — membership needs online chat events")
  }
  const rows = new Map((stats.series ?? []).map((row) => [row.key, row]))
  const keys = [...rows.keys()].sort()
  const values = keysBetween(keys, by)
  const heading = headings[kind]
  const one = values.map((key) => {
    const row = rows.get(key)
    return row === undefined
      ? null
      : kind === "messages"
        ? row.messages
        : kind === "active"
          ? row.senders
          : (row.joined ?? null)
  })
  const series: ChartData["series"] = [{ name: heading.name, values: one }]
  if (kind === "membership") {
    series.push({ name: "Left", values: values.map((key) => rows.get(key)?.left ?? null) })
  }
  const reasons: ChartData["reasons"] = []
  if (stats.completeness.state !== "complete") reasons.push("store-incomplete")
  if (stats.members?.more) reasons.push("events-incomplete")
  return {
    version: 1,
    kind: heading.kind,
    title: `${heading.title} per ${by}`,
    x: { type: by, values },
    series,
    unit: heading.unit,
    timezone,
    partial: !stats.complete,
    reasons,
  }
}
