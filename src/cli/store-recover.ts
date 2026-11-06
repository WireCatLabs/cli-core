import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { type DamageExplanation, explainDamage } from "../store/damage.js"
import { storeHealth } from "../store/health.js"
import { storePath } from "../store/path.js"
import {
  activeTimers,
  type RecoverOptions,
  type Recovery,
  recoverStore,
  sqlite3Program,
  storeHolders,
  tableRows,
} from "../store/recover.js"
import { openSqlite } from "../store/store.js"
import { environmentOf, outputFor } from "./context.js"
import { LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"

/** The tables whose counts say what the store holds; every other table is in `store info`. */
const COUNTED = [
  "accounts",
  "chats",
  "messages",
  "attachments",
  "emails",
  "documents",
  "notes",
  "meetings",
  "chunks",
  "embeddings",
  "mentions",
]

export interface RecoveryCheck {
  path: string
  exists: boolean
  ok: boolean
  seconds?: number
  problems?: number
  damagedTables?: { table: string | null; problems: number; sample: string }[]
  damagedSearchIndexes?: { name: string; error?: string }[]
  rows?: Record<string, number | null>
  explanation?: DamageExplanation | null
  inUse?: { pid: number; name: string }[] | null
  timers?: string[] | null
  sqlite3?: { version: string | null; usable: boolean }
  /** The commands to run, in order. */
  next: string[]
}

const stopTimers = (timers: string[]) => `systemctl --user stop ${timers.join(" ")}`

/** `store recover`: what is wrong with the store and what to run, reading every page; changes nothing. */
export const storeRecoveryCheck = async (env: NodeJS.ProcessEnv, command: string): Promise<RecoveryCheck> => {
  const path = storePath(env)
  if (!existsSync(path)) return { path, exists: false, ok: true, next: [] }
  const health = await storeHealth(path, { deep: true })
  let rows: Record<string, number | null> = {}
  try {
    const { database } = await openSqlite(path, { readOnly: true })
    try {
      const all = tableRows(database)
      rows = Object.fromEntries(COUNTED.filter((table) => table in all).map((table) => [table, all[table] ?? null]))
    } finally {
      database.close()
    }
  } catch {}
  const explanation = explainDamage(health, command)
  const inUse = storeHolders(path) ?? null
  const timers = activeTimers() ?? null
  const sqlite3 = sqlite3Program()
  const next = health.ok
    ? []
    : [
        ...(timers?.length ? [stopTimers(timers)] : []),
        ...(inUse ?? []).map(({ pid, name }) => `stop ${name} (process ${pid}): it has the store open`),
        ...(sqlite3.usable ? [] : ["install sqlite3 3.43 or newer (apt install sqlite3, brew install sqlite)"]),
        `${command} store recover run`,
      ]
  return {
    path,
    exists: true,
    ok: health.ok,
    seconds: Math.round(health.ms / 100) / 10,
    problems: health.problems ?? 0,
    damagedTables: health.damagedTables ?? [],
    damagedSearchIndexes: (health.searchIndexes ?? [])
      .filter((index) => !index.ok)
      .map(({ name, error }) => ({ name, ...(error ? { error } : {}) })),
    rows,
    explanation,
    inUse,
    timers,
    sqlite3: { version: sqlite3.version, usable: sqlite3.usable },
    next,
  }
}

export type RecoveryRun = Omit<Recovery, "health" | "copyErrors"> & {
  /** `sqlite3` reported these while copying; most are rows that broke a constraint and were skipped. */
  copyErrors: number
  checkedOk: boolean
  /** The commands that fetch again what was lost, then the timers to start. */
  next: string[]
}

/** `store recover run`: refuses while a WireCat timer is scheduled, so none writes to the file being replaced. */
export const storeRecoveryRun = async (
  env: NodeJS.ProcessEnv,
  {
    command,
    version,
    note,
    timers: scheduled = activeTimers,
    copy,
  }: {
    command: string
    version?: string
    note?: (text: string) => void
    timers?: () => string[] | undefined
    copy?: RecoverOptions["copy"]
  },
): Promise<RecoveryRun> => {
  const timers = scheduled() ?? []
  if (timers.length > 0)
    throw new CliError("validation_error", `stop the timers first, they open the store: ${stopTimers(timers)}`, {
      reason: "store.in-use",
    })
  const recovery = await recoverStore({
    path: storePath(env),
    command,
    ...(version ? { version } : {}),
    ...(note ? { note } : {}),
    ...(copy ? { copy } : {}),
  })
  const mail = recovery.mailToFetch.map(
    ({ account, emails }) => `mail <profile of ${account}> sync --rescan   # ${emails} emails`,
  )
  const lostMail =
    recovery.lost.some(({ table }) => table === "emails") && mail.length === 0
      ? ["mail <profile> sync --rescan   # each mail profile"]
      : []
  const { health, copyErrors, ...kept } = recovery
  return {
    ...kept,
    copyErrors: copyErrors.length,
    checkedOk: health.ok,
    next: [...mail, ...lostMail, "systemctl --user start <the timers stopped before>"],
  }
}

/** The lines a person reads under the answer; the JSON carries the same in its fields. */
export const recoveryNotes = (answer: RecoveryCheck | RecoveryRun): string[] => {
  if ("keptAt" in answer) {
    const lost = answer.lost.map(
      ({ table, before, read, kept }) =>
        `${table}: ${kept} kept of ${before ?? "an uncountable number"}${read > kept ? `, ${read - kept} read but unusable` : ""}`,
    )
    return [
      `recovered in ${answer.seconds.total} s; the damaged file is kept at ${answer.keptAt}`,
      ...(lost.length ? lost : ["no table lost a row"]),
      ...answer.dangling.map(
        ({ table, parent, rows }) => `${rows} rows of ${table} point at ${parent} rows the store does not hold`,
      ),
      ...answer.next.map((line) => `next: ${line}`),
    ]
  }
  if (!answer.exists) return ["no store yet"]
  if (answer.ok) return [`the store is healthy (checked every page and search index in ${answer.seconds} s)`]
  const why = answer.explanation
  return [
    ...(why ? [why.what, ...why.impact, why.externalUnaffected] : []),
    ...answer.next.map((line) => `next: ${line}`),
  ]
}

/** `store recover` and `store recover run`, for a CLI whose commands run on cli-core's context. */
export const storeRecoverCommand = ({ command, version }: { command: string; version?: string }): Command => {
  const recover = annotate(new Command("recover"), { effects: LOCAL_READ, examples: [`${command} store recover`] })
    .summary("what is damaged in the store and how to recover it")
    .description(
      "check every page and search index of the store, say what is damaged, what it means and the commands that recover it; changes nothing",
    )
    .action(async function (this: Command) {
      const output = outputFor(this)
      const answer = await storeRecoveryCheck(environmentOf(this).env ?? process.env, command)
      renderAnswer(this, output, itemOf(snakeKeys(answer)))
      if (output.format === "pretty") for (const line of recoveryNotes(answer)) output.renderer.note(line)
    })
  recover.addCommand(
    annotate(new Command("run"), { effects: LOCAL_WRITE, examples: [`${command} store recover run`] })
      .summary("rebuild a damaged store from every row it can read")
      .description(
        "copy every readable row into a new file with the sqlite3 program, rebuild the search indexes, mentions and vector index, " +
          "check it, and put it in place of the store; the damaged file is kept beside it. Refuses while a WireCat timer or process has the store",
      )
      .action(async function (this: Command) {
        const output = outputFor(this)
        const answer = await storeRecoveryRun(environmentOf(this).env ?? process.env, {
          command,
          ...(version ? { version } : {}),
          note: (text) => output.renderer.note(text),
        })
        renderAnswer(this, output, itemOf(snakeKeys(answer)))
        if (output.format === "pretty") for (const line of recoveryNotes(answer)) output.renderer.note(line)
      }),
  )
  return recover
}
