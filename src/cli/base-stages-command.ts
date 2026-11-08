import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import { Argument, Command, InvalidArgumentError, Option } from "commander"
import * as v from "valibot"
import { DEAL_KINDS, type DealKind, STAGE_OUTCOMES, type StageOutcome } from "../domain/deals.js"
import { count, reference, text, untrusted } from "../entities/fields.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import type { BaseScope, BaseSet, MessageStore, StageMapping } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { answerEntity } from "./answer-entity.js"
import { environmentOf } from "./context.js"
import { LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf, listOf, snakeKeys } from "./envelope.js"
import { queryTerms, termField, withQuery } from "./list-query.js"

export interface BaseStagesCommandOptions {
  /** The run's environment, read for an agent's markers: an agent suggests mappings, the owner confirms and edits. */
  env: () => NodeJS.ProcessEnv
  /** The store for one command; the command closes it once its answer is built. */
  open: (command: Command) => Promise<MessageStore>
  output: (answer: Body, command: Command) => void
  /**
   * The CRM accounts the run may read and change, such as a group lock's; `undefined` for all. The owner's own
   * pipelines are always in.
   */
  accounts?: (store: MessageStore, command: Command) => Promise<readonly AccountKey[] | undefined>
}

const outcome = v.picklist(STAGE_OUTCOMES)
const kind = v.picklist(DEAL_KINDS)
const named = v.strictObject({ ref: reference, name: text })

const baseSet = v.strictObject({
  kind,
  /** `null`, with each stage's `ref`, only when a read-only store is read before the set's first use made it. */
  pipeline: v.nullable(reference),
  stages: v.array(
    v.strictObject({ ref: v.nullable(reference), name: text, position: count, outcome, open: count, mapped: count }),
  ),
  unsorted: v.strictObject({ open: count, stages: count }),
})

const stageMapping = v.strictObject({
  ...named.entries,
  position: count,
  outcome,
  kind,
  pipeline: reference,
  pipeline_name: text,
  account: v.nullable(v.strictObject({ provider: text, account: text })),
  base_stage: v.nullable(named),
  confirmed: v.boolean(),
  open: count,
  untrusted,
})

/** A CRM's users named its stages and pipelines; the base set's names are the owner's. */
const MAPPING_UNTRUSTED = ["name", "pipeline_name"]

/** What `stages list` narrows by. */
const MAPPING_QUERY = {
  entity: "stage_mapping",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:deal", { values: DEAL_KINDS }),
    termField("pipeline", "kw", "pipeline:Sales", { relation: "pipeline:<id>, or a name only one pipeline has" }),
    termField("confirmed", "bool", "confirmed:false"),
  ],
} as const satisfies QueryRegistry

const position = (value: string) => {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError("expected a position from 1")
  return Number(value)
}

const kindArgument = () => new Argument("<kind>", "deal or lead: which base set").choices(DEAL_KINDS)

/**
 * `stages …`: the owner's base stages of deals and of leads, and the CRM stages mapped onto them. memo mounts it; a CRM
 * CLI moves a card to a base stage with `deals move <ref> stage:<id>`.
 */
export const baseStagesCommand = (app: AppIdentity, options: BaseStagesCommandOptions): Command => {
  const isAgent = (command: Command) => Boolean(environmentOf(command).agent || agentOf(options.env()))
  // A guard against a change by mistake, not a boundary, as the owner-only store settings are.
  const ownerOnly = (command: Command, what: string) => {
    if (isAgent(command))
      throw new CliError(
        "permission_error",
        `${what} is the owner's to do, in a terminal: an agent's run is stopped from changing it by mistake`,
        { reason: "stage.owner-only" },
      )
  }
  const run = async (command: Command, work: (store: MessageStore, scope: BaseScope) => Promise<Body>) => {
    const store = await options.open(command)
    let body: Body
    try {
      const accounts = await options.accounts?.(store, command)
      body = await work(store, accounts === undefined ? {} : { accounts })
    } finally {
      await store.close()
    }
    options.output(body, command)
  }
  const stages = annotate(new Command("stages"), { effects: LOCAL_READ })
    .description(
      "the owner's base stages of deals and of leads, the columns of a board across every pipeline and CRM, and " +
        "how each CRM stage maps onto them",
    )
    .summary("base stages and the CRM stages mapped onto them")
  const leaf = (name: string, effects: typeof LOCAL_READ, summary: string, ...examples: string[]) =>
    annotate(stages.command(name), {
      effects,
      examples: examples.map((line) => `${app.command} stages ${line}`),
    }).summary(summary)
  const setAnswer = (set: BaseSet) => itemOf(snakeKeys(set))
  const setCommand = (name: string, summary: string, ...examples: string[]) =>
    answerEntity(leaf(name, LOCAL_WRITE, summary, ...examples), "base_stage_set", baseSet)
      .addArgument(kindArgument())
      .hook("preAction", (_root, command) => ownerOnly(command, `stages ${name}`))
  const mappingRow = (row: StageMapping) => ({ ...(snakeKeys(row) as object), untrusted: MAPPING_UNTRUSTED })
  const baseStage = "the base stage, by its stage:<id> or its name"

  answerEntity(
    leaf("show", LOCAL_READ, "a base set's columns with what each holds", "show deal", "show lead --json"),
    "base_stage_set",
    baseSet,
  )
    .description(
      "the base set in order, with the open rows and CRM stages each column holds, and what is unsorted (unmapped " +
        "or only suggested); the first use takes the owner's only own pipeline of the kind, or makes the default set in " +
        "the owner's language; a read-only store shows that set without making it",
    )
    .addArgument(kindArgument())
    .action(async (chosen: DealKind, _opts: unknown, command: Command) => {
      await run(command, async (store, scope) => setAnswer(await store.baseStages.show(chosen, scope)))
    })

  setCommand("create", "add a stage to a base set", 'create deal "Demo"', 'create lead "Spam" lost')
    .description(
      "add a stage to the base set: an open one goes before the first won or lost stage, a won or lost one last; " +
        "move puts it elsewhere",
    )
    .argument("<name>", "the stage's name, once in its set")
    .addArgument(new Argument("[outcome]", "open, won or lost; open by default").choices(STAGE_OUTCOMES))
    .action(
      async (chosen: DealKind, name: string, given: StageOutcome | undefined, _opts: unknown, command: Command) => {
        await run(command, async (store) =>
          setAnswer(await store.baseStages.add(chosen, { name, ...(given === undefined ? {} : { outcome: given }) })),
        )
      },
    )

  setCommand("rename", "rename a base stage", 'rename deal Proposal "Quote sent"')
    .description("rename a base stage; what maps to it stays mapped")
    .argument("<stage>", baseStage)
    .argument("<name>", "its new name")
    .action(async (chosen: DealKind, stage: string, name: string, _opts: unknown, command: Command) => {
      await run(command, async (store) => setAnswer(await store.baseStages.rename(chosen, stage, name)))
    })

  setCommand("move", "put a base stage at another place in its set", "move deal Negotiation 2")
    .description("put a base stage at another place in its set; unconfirmed suggestions follow the new order")
    .argument("<stage>", baseStage)
    .argument("<position>", "its new place, from 1", position)
    .action(async (chosen: DealKind, stage: string, at: number, _opts: unknown, command: Command) => {
      await run(command, async (store) => setAnswer(await store.baseStages.move(chosen, stage, at)))
    })

  setCommand("remove", "take a stage out of a base set", "remove deal Negotiation")
    .description(
      "take a stage out of the base set: refused for the last of its outcome and for one the owner's own rows stood " +
        "in; what was mapped to it waits for a new confirm",
    )
    .argument("<stage>", baseStage)
    .action(async (chosen: DealKind, stage: string, _opts: unknown, command: Command) => {
      await run(command, async (store) => setAnswer(await store.baseStages.remove(chosen, stage)))
    })

  withQuery(
    answerEntity(
      leaf(
        "list",
        LOCAL_READ,
        "every CRM stage with its base stage, confirmed or suggested",
        "list confirmed:false",
        "list kind:deal pipeline:pipeline:3 --json",
      ),
      "stage_mapping",
      stageMapping,
    ).description(
      "every CRM stage in scope with the base stage it maps to, and whether the owner confirmed that or it is the " +
        "store's suggestion",
    ),
    MAPPING_QUERY,
  ).action(async (words: string[], _opts: unknown, command: Command) => {
    const terms = queryTerms(words, MAPPING_QUERY, "stages list")
    await run(command, async (store, scope) => {
      const rows = await store.baseStages.mappings({
        ...scope,
        ...(terms.has("kind") ? { kind: terms.get("kind") as DealKind } : {}),
        ...(terms.has("pipeline") ? { pipeline: terms.get("pipeline") as string } : {}),
      })
      const confirmed = terms.get("confirmed")
      const shown = confirmed === undefined ? rows : rows.filter((row) => row.confirmed === (confirmed === "true"))
      return listOf("stages list", {
        items: shown.map(mappingRow),
        limit: Math.max(1, shown.length),
        page: 1,
        has_more: false,
        ...(words.length ? { args: { query: words } } : {}),
      })
    })
  })

  answerEntity(
    leaf("set", LOCAL_WRITE, "map one CRM stage onto a base stage, confirmed", "set stage:41 Proposal"),
    "stage_mapping",
    stageMapping,
  )
    .description(
      "map one CRM stage onto a base stage of its kind, confirmed, so a later sync keeps it; an agent's run records " +
        "it as a suggestion the owner confirms",
    )
    .argument("<stage>", "the CRM stage, by its stage:<id> as stages list shows it")
    .argument("<base-stage>", baseStage)
    .action(async (stage: string, target: string, _opts: unknown, command: Command) => {
      await run(command, async (store, scope) =>
        itemOf(mappingRow(await store.baseStages.map(stage, target, scope, { confirmed: !isAgent(command) }))),
      )
    })

  answerEntity(
    leaf(
      "confirm",
      LOCAL_WRITE,
      "confirm the suggested mappings of a pipeline, or of all",
      "confirm --pipeline pipeline:3",
      "confirm --all",
    ),
    "stage_mapping_confirm",
    v.strictObject({ confirmed: count }),
  )
    .description("confirm every suggestion of one pipeline, or of all of them in scope, as it stands")
    .option("--pipeline <pipeline>", "pipeline:<id>, or a name only one pipeline has")
    .option("--all", "every pipeline in scope")
    .addOption(new Option("--kind <kind>", "with --all: only deal or only lead stages").choices(DEAL_KINDS))
    .action(async (opts: { pipeline?: string; all?: boolean; kind?: DealKind }, command: Command) => {
      ownerOnly(command, "stages confirm")
      if ((opts.pipeline === undefined) === (opts.all !== true))
        throw new CliError("validation_error", "give --pipeline <pipeline> or --all", { reason: "stage.base-field" })
      await run(command, async (store, scope) => {
        const target =
          opts.pipeline === undefined
            ? { all: true as const, ...(opts.kind === undefined ? {} : { kind: opts.kind }) }
            : { pipeline: opts.pipeline }
        return itemOf({ confirmed: await store.baseStages.confirm(target, scope) })
      })
    })

  return stages
}
