import { timezoneOf } from "@wirecat/cli-base/query"
import * as v from "valibot"
import { chatChart } from "../../charts/chat.js"
import { CHART_KINDS, CHART_SIZE } from "../../charts/model.js"
import { chartPng } from "../../charts/png.js"
import { chartRenderer } from "../../charts/render.js"
import { sealed } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { chartAnswer } from "../../cli/messenger/stats-answers.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { dateWindow } from "../../services/moment.js"
import { type AnyTool, chatOf, Picture, READ, tool } from "../tool.js"

export const statsTools = (messenger: Messenger): Record<string, AnyTool> => ({
  stats_charts: tool({
    title: "A chart from a chat's statistics",
    description:
      "A neutral chart description as JSON, or a dark PNG image beside that JSON when format is png: " +
      "messages or active authors per day or week, from the local store. " +
      "Missing dates are gaps, and partial marks lower bounds. Membership needs online events and is unavailable here. " +
      "No image file is written and no messenger connection is opened.",
    input: v.object({
      chat: chatOf(messenger),
      chart_kind: v.optional(v.picklist(CHART_KINDS)),
      by: v.optional(v.picklist(["day", "week"])),
      since_time: v.optional(v.pipe(v.string(), v.description("an ISO 8601 time, or 2h / 1d ago"))),
      timezone: v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar days"))),
      format: v.optional(v.pipe(v.picklist(["json", "png"]), v.description("JSON by default; png adds image content"))),
    }),
    annotations: { ...READ, openWorldHint: false },
    output: { entity: "chart", list: false },
    stored: async (store, account, args, defaults) => {
      const timezone = timezoneOf(args.timezone)
      const by = args.by ?? "day"
      const window = dateWindow({
        ...(args.since_time === undefined ? {} : { sinceTime: args.since_time }),
        zone: timezone,
        names: ["since_time", "until_time"],
      })
      const stats = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats(args.chat, {
        by,
        timezone,
        ...(window.since === undefined ? {} : { since: window.since }),
      })
      const chart = chatChart(stats, { kind: args.chart_kind ?? "messages", by, timezone })
      if (args.format !== "png") return chartAnswer(chart, undefined, window.meta)
      const image = await chartPng(await (await chartRenderer()).render(chart, CHART_SIZE))
      return new Picture(image.bytes, image.mimeType, sealed(chartAnswer(chart, undefined, window.meta)))
    },
  }),
})
