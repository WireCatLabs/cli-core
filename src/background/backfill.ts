import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import { prepareReport, type StoredTemplates } from "./report/render.js"
import { type AgentCli, attemptSchedule, KILL_AFTER_MS, type LastRun, readSchedule, sharedLinks } from "./schedules.js"
import type { ServerSystem } from "./system.js"

/**
 * One past day's run of an agent schedule, as its timer would have made it at `at`: the same harness, flags, per-run
 * cap and input, the report rendered as of `at` and kept in `runs/` under that time, with `"backfill": true` in its
 * `.report.json`. It sends nothing, shows no notice, and leaves `last.json` and `latest.*` as they are; its cost counts
 * in today's spend, as any run's does.
 */
export const backfillSchedule = async (
  app: AppIdentity,
  system: ServerSystem,
  env: NodeJS.ProcessEnv,
  file: string,
  {
    at,
    input,
    now = () => new Date(),
    signal,
    killAfterMs = KILL_AFTER_MS,
    agentRuns = [],
    ownerLanguage = async () => "ru",
    reportTemplates,
  }: {
    at: Date
    /** What the agent reads on its stdin before its first turn: here, which day it writes and the window it reads. */
    input?: string
    now?: () => Date
    signal?: AbortSignal
    killAfterMs?: number
    agentRuns?: readonly AgentCli[]
    ownerLanguage?: (env: NodeJS.ProcessEnv) => Promise<string>
    reportTemplates?: (env: NodeJS.ProcessEnv) => StoredTemplates
  },
): Promise<LastRun> => {
  const schedule = readSchedule(file)
  if (schedule.kind !== "agent")
    throw new CliError(
      "validation_error",
      `${schedule.name} runs a command, not an agent; only an agent's report is built for a past day`,
    )
  const folder = join(file, "..")
  mkdirSync(join(folder, "runs"), { recursive: true, mode: 0o700 })
  const last = (await attemptSchedule(app, system, env, schedule, folder, {
    now,
    signal,
    killAfterMs,
    agentRuns,
    agentInput: input === undefined ? undefined : async () => input,
    at,
  })) as LastRun
  if (last.exitCode !== 0) return last
  const runEnv = { ...env, ...schedule.environment }
  const prepared = await prepareReport(readFileSync(last.output, "utf8"), {
    language: await ownerLanguage(runEnv).catch(() => "ru"),
    now: at.getTime(),
    links: sharedLinks(runEnv),
    env: runEnv,
    ...(reportTemplates ? { templates: reportTemplates(runEnv) } : {}),
  })
  if (!prepared) return last
  if (prepared.document)
    writeFileSync(
      last.output.replace(/\.md$/, ".report.json"),
      `${JSON.stringify({ ...JSON.parse(prepared.document), backfill: true }, null, 2)}\n`,
      { mode: 0o600 },
    )
  return { ...last, report: prepared.run }
}
