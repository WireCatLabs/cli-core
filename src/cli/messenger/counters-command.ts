import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { CounterQuery } from "../../services/counters.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

export const countersCommand = (messenger: Messenger) => {
  const parent = new Command("counters").description("per-counter observations and bounded remote refresh")
  for (const operation of ["show", "refresh"] as const) {
    const command = new Command(operation)
      .description(
        operation === "show"
          ? "show saved counter values and their observation freshness"
          : "read authoritative counters for bounded messages and update their local observations",
      )
      .argument("[query...]", "strict Lucene query over stored messages")
      .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
      .option("--source <messenger>", "held accounts of this messenger; refresh uses the active account")
      .option("--exact", "bare words match exact forms")
      .option("--timezone <zone>", "IANA timezone for query dates")
      .option(
        "--selection <json>",
        "pinned counter-targets selection from counters show; conflicts with query and scope",
      )
      .option("--counters <names>", "distinct views,reactions,comments fields; all three by default")
      .option("--limit <n>", "messages, 1–100; 20 by default", positiveCount("--limit"))
    if (operation === "show") command.option("--max-age <duration>", "maximum fresh observation age; 24h by default")
    if (operation === "refresh") annotate(command, { mutates: true, local: true })
    if (operation === "refresh")
      command
        .option("--max-messages <n>", "maximum messages to refresh, 1–100", positiveCount("--max-messages"))
        .option("--sync-time <duration>", "remote refresh budget; 30s by default, maximum 5m")
        .option("--dry-run", "preview exact stored targets and counter capabilities without connecting")
    command.action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger),
        options = this.opts<CounterQuery>()
      if (operation === "refresh" && !options.dryRun)
        refuseLocalWrite(context, messenger.app.command, "stats.messages.counters.refresh")
      const query = {
        ...options,
        limit: options.limit ?? 20,
        ...(words.length ? { text: words.join(" ") } : {}),
        signal: environmentOf(this).commandSignal ?? environmentOf(this).signal,
      }
      const found = await context.withServices(async (services) => await services.counters[operation](query))
      if (context.format === "jsonl" && "items" in found) context.renderer.stream(found.items)
      else context.renderer.result(found)
    })
    parent.addCommand(command)
  }
  return parent
}
