import { CliError, type ErrorCode, resolvePaths } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { clockMeta } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { runBudgetOf } from "../../cli/context.js"
import { destroysNothing, FETCH } from "../../cli/effects.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import { parseDuration } from "../../domain/duration.js"
import { readOnlyRefusal } from "../../ports/app.js"
import { levelRefusal } from "../../sends/guard.js"
import { DEFAULT_PERMISSIONS, levelFor } from "../../sends/permissions.js"
import { dueEvents, openReminders, reminderItem, remindersPath, runHook } from "../remind.js"
import { syncCalendars } from "../sync.js"
import { CALENDAR_WRITE_DEFAULTS, EVENTS_REMIND_HOOK_KEY } from "../writer.js"
import type { CalendarWrites } from "../writes.js"
import type { CalendarCommandDeps } from "./index.js"

interface RemindHelpers {
  deps: CalendarCommandDeps
  now: () => number
  zone: () => string
  print: (value: unknown, command: Command) => void
  example: (command: Command, ...lines: string[]) => Command
}

const REMIND_MIN_MS = 60_000
const REMIND_MAX_MS = 86_400_000

export const addRemind = (
  events: Command,
  writes: CalendarWrites,
  { deps, now, zone, print, example }: RemindHelpers,
) => {
  const remind = example(
    destroysNothing(annotate(events.command("remind"), { effects: FETCH, mcp: false }))
      .description(
        "tell once about each event that starts within --due-within: print it, or run your program for it with the " +
          "event as JSON on its standard input; for cron or a timer every few minutes, syncing first unless --offline",
      )
      .summary("tell once about each event that starts soon, for a timer to run")
      .argument(
        "[program...]",
        "after --: the program to run for each event, and its own arguments; no shell. Needs events.remind.hook " +
          "allowed",
      ),
    "events remind --due-within 10m",
    "events remind --due-within 15m -- /home/me/bin/meeting-reminder",
  )
    .option("--due-within <duration>", "the events that start within this long from now, 1m to 1d", "10m")
    .option("--dry-run", "say what it would remind; run nothing, sync nothing, remember nothing")
  remind.action(async (program: string[], opts: { dueWithin: string; dryRun?: boolean }, command: Command) => {
    const within = parseDuration(opts.dueWithin, "--due-within")
    if (within < REMIND_MIN_MS || within > REMIND_MAX_MS)
      throw new CliError("validation_error", "--due-within takes 1m to 1d", { reason: "remind.window" })
    const settings = writes.settings()
    const env = writes.env ?? process.env
    const hook = program.length > 0
    const defaults = { ...DEFAULT_PERMISSIONS, ...CALENDAR_WRITE_DEFAULTS, ...settings.permissionDefaults }
    const { level, key: named } = levelFor(settings.permissions, EVENTS_REMIND_HOOK_KEY, defaults)
    if (hook && !opts.dryRun) {
      if (settings.readOnlyLock) throw readOnlyRefusal(settings.readOnlyLock, "run a program for a reminder")
      if (level === "deny" || level === "readonly")
        throw levelRefusal({
          profile: settings.profile,
          command: writes.app.command,
          key: EVENTS_REMIND_HOOK_KEY,
          level,
          named,
          permissionSources: settings.permissionSources,
        })
    }
    const at = now()
    const issues: { code: ErrorCode; reason: string; source: string }[] = []
    const accountName = `${deps.account.provider}:${deps.account.account}`
    if (!opts.dryRun && deps.source && !command.optsWithGlobals<{ offline?: boolean }>().offline) {
      // A reminder from what the store already holds beats none: a failed sync is said in meta and the run goes on.
      try {
        const report = await syncCalendars(deps.source, deps.store, {
          accountId: deps.accountId,
          now: at,
          budget: runBudgetOf(command),
          ...(deps.expand ? { expand: deps.expand } : {}),
        })
        if (report.synced.some((one) => one.error !== undefined))
          issues.push({ code: "provider_error", reason: "sync.partial", source: accountName })
      } catch (error) {
        issues.push({
          code: error instanceof CliError ? error.code : "provider_error",
          reason: "sync.failed",
          source: accountName,
        })
      }
    }
    const window = { from: at, to: at + within }
    const path = remindersPath(
      resolvePaths({ appName: writes.app.appName, prefix: writes.app.envPrefix, env }).state,
      settings.profile,
    )
    const reminders = opts.dryRun ? undefined : openReminders(path, at)
    try {
      const due = await dueEvents(deps.store, deps.accountId, window, reminders?.reminded ?? {})
      if (hook && !opts.dryRun && due.length > 0 && level === "ask")
        await terminalAsker(command)(EVENTS_REMIND_HOOK_KEY, { chatId: null, count: due.length })
      const items = []
      const failed: { ref: string; exit_code: number }[] = []
      for (const details of due) {
        const item = reminderItem(details)
        if (hook && !opts.dryRun) {
          const exitCode = await runHook(program, `${JSON.stringify(item)}\n`, {
            ...env,
            [`${writes.app.envPrefix}_PROFILE`]: settings.profile,
            [`${writes.app.envPrefix}_EVENT`]: item.ref,
          })
          if (exitCode !== 0) {
            failed.push({ ref: item.ref, exit_code: exitCode })
            continue
          }
        }
        reminders?.remember(details)
        items.push(item)
      }
      if (failed.length)
        throw new CliError(
          "configuration_error",
          `${program[0]} failed for ${failed.length} of ${due.length} events ` +
            `(${failed.map((one) => `${one.ref}: exit ${one.exit_code}`).join(", ")}); the next run tries them again`,
          { reason: "remind.hook-failed", reminded: items.map(({ ref }) => ref), failed, retryable: true },
        )
      print(
        {
          items,
          page: 1,
          limit: Math.max(1, items.length),
          hasMore: false,
          meta: {
            complete: issues.length === 0,
            ...(issues.length ? { issues } : {}),
            window: { since: new Date(window.from).toISOString(), until: new Date(window.to).toISOString() },
            ...clockMeta(at, zone()),
          },
        },
        command,
      )
    } finally {
      reminders?.close()
    }
  })
}
