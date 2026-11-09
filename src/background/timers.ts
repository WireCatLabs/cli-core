import { rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, writeSecurely } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import type { Schedule } from "./schedules.js"
import type { ServerSystem } from "./system.js"
import { describeWhen, localStamp, onCalendar, type Slot, slotsOf, WEEKDAYS, type When, WINDOWS_DAYS } from "./when.js"

/** How one operating system starts `argv` at the schedule's times. Every timer runs the same thing: `<cli> schedule exec <file>`. */
export interface Timer {
  install: (schedule: Schedule, argv: string[]) => Promise<void>
  remove: (name: string) => Promise<void>
  /** Where the timer lives, for the owner to look at. */
  where: (name: string) => string
}

const systemdQuote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const checked = async (system: ServerSystem, env: NodeJS.ProcessEnv, argv: string[], allowFailure = false) => {
  const ran = await system.run(argv, env)
  if (ran.code !== 0 && !allowFailure) {
    throw new CliError("configuration_error", `${argv[0]} failed: ${(ran.stderr || ran.stdout).trim()}`)
  }
  return ran
}

export const systemdTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv, home: string): Timer => {
  const folder = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user")
  const unit = (name: string) => `${app.command}-schedule-${name}`
  return {
    where: (name) => join(folder, `${unit(name)}.timer`),
    install: async (schedule, argv) => {
      const { when } = schedule
      writeSecurely(
        join(folder, `${unit(schedule.name)}.service`),
        [
          "[Unit]",
          `Description=${app.command} schedule ${schedule.name}`,
          "",
          "[Service]",
          "Type=oneshot",
          `ExecStart=${argv.map(systemdQuote).join(" ")}`,
          "",
        ].join("\n"),
        0o644,
      )
      writeSecurely(
        join(folder, `${unit(schedule.name)}.timer`),
        [
          "[Unit]",
          `Description=${app.command} schedule ${schedule.name} — ${describeWhen(when)}`,
          "",
          "[Timer]",
          ...("every" in when
            ? // From when a run ends: counted from its start, a run longer than the interval left no next run.
              [`OnActiveSec=${when.every}min`, `OnUnitInactiveSec=${when.every}min`]
            : // Persistent: a run missed while the machine slept happens when it wakes.
              [...onCalendar(when).map((value) => `OnCalendar=${value}`), "Persistent=true"]),
          "",
          "[Install]",
          "WantedBy=timers.target",
          "",
        ].join("\n"),
        0o644,
      )
      await checked(system, env, ["systemctl", "--user", "daemon-reload"])
      await checked(system, env, ["systemctl", "--user", "enable", "--now", `${unit(schedule.name)}.timer`])
    },
    remove: async (name) => {
      await checked(system, env, ["systemctl", "--user", "disable", "--now", `${unit(name)}.timer`], true)
      rmSync(join(folder, `${unit(name)}.timer`), { force: true })
      rmSync(join(folder, `${unit(name)}.service`), { force: true })
      await checked(system, env, ["systemctl", "--user", "daemon-reload"])
    },
  }
}

export const launchdTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv, home: string): Timer => {
  const folder = join(home, "Library", "LaunchAgents")
  const label = (name: string) => `${app.appName}.schedule.${name}`
  const plist = (name: string) => join(folder, `${label(name)}.plist`)
  const domain = `gui/${system.uid}`
  const entry = ({ at, on }: Slot, once?: Date) => {
    const [hour, minute] = at.split(":").map(Number)
    return [
      "    <dict>",
      // launchd has no year: a one-off is a yearly date, and the run removes it.
      ...(once
        ? [
            `      <key>Month</key><integer>${once.getMonth() + 1}</integer>`,
            `      <key>Day</key><integer>${once.getDate()}</integer>`,
          ]
        : []),
      // launchd counts Sunday as 0.
      ...(on ? [`      <key>Weekday</key><integer>${(WEEKDAYS.indexOf(on) + 1) % 7}</integer>`] : []),
      `      <key>Hour</key><integer>${hour}</integer>`,
      `      <key>Minute</key><integer>${minute}</integer>`,
      "    </dict>",
    ]
  }
  const calendar = (when: When) => {
    if ("every" in when) return [`  <key>StartInterval</key><integer>${when.every * 60}</integer>`]
    const entries =
      "once" in when
        ? entry({ at: localStamp(when.once).slice(11, 16) }, new Date(when.once))
        : slotsOf(when).flatMap((slot) => entry(slot))
    return ["  <key>StartCalendarInterval</key>", "  <array>", ...entries, "  </array>"]
  }
  return {
    where: plist,
    install: async (schedule, argv) => {
      await checked(system, env, ["launchctl", "bootout", `${domain}/${label(schedule.name)}`], true)
      writeSecurely(
        plist(schedule.name),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0">',
          "<dict>",
          `  <key>Label</key><string>${xml(label(schedule.name))}</string>`,
          "  <key>ProgramArguments</key>",
          "  <array>",
          ...argv.map((word) => `    <string>${xml(word)}</string>`),
          "  </array>",
          ...calendar(schedule.when),
          "</dict>",
          "</plist>",
          "",
        ].join("\n"),
        0o644,
      )
      await checked(system, env, ["launchctl", "bootstrap", domain, plist(schedule.name)])
    },
    remove: async (name) => {
      await checked(system, env, ["launchctl", "bootout", `${domain}/${label(name)}`], true)
      rmSync(plist(name), { force: true })
    },
  }
}

/**
 * Task Scheduler through PowerShell's ScheduledTasks module. The values travel in variables, never in
 * the script, so nothing needs quoting for PowerShell; Windows has no per-task environment, which is why
 * the runner reads its variables from the schedule file.
 */
export const windowsTimer = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Timer => {
  const path = `\\${app.appName}\\`
  const powershell = (script: string, values: Record<string, string>, allowFailure = false) =>
    checked(
      system,
      { ...env, ...values },
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      allowFailure,
    )
  return {
    where: (name) => `Task Scheduler ${path}${name}`,
    install: async (schedule, [exe = "", ...args]) => {
      const { when } = schedule
      await powershell(
        [
          "$ErrorActionPreference = 'Stop'",
          "$action = New-ScheduledTaskAction -Execute $env:WIRECAT_EXE -Argument $env:WIRECAT_ARGS",
          "$trigger = switch ($env:WIRECAT_KIND) {",
          "  'every' { New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ([int]$env:WIRECAT_MINUTES)) }",
          "  'daily' { New-ScheduledTaskTrigger -Daily -At $env:WIRECAT_AT }",
          "  'weekly' { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $env:WIRECAT_DAY -At $env:WIRECAT_AT }",
          "  'calendar' { @(foreach ($slot in $env:WIRECAT_SLOTS.Split(';')) { $day, $at = $slot.Split('|'); if ($day) { New-ScheduledTaskTrigger -Weekly -DaysOfWeek $day -At $at } else { New-ScheduledTaskTrigger -Daily -At $at } }) }",
          "  'once' { New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact($env:WIRECAT_AT, 'yyyy-MM-dd HH:mm:ss', $null)) }",
          "}",
          "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew",
          "Register-ScheduledTask -TaskName $env:WIRECAT_NAME -TaskPath $env:WIRECAT_PATH -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
        ].join("\n"),
        {
          WIRECAT_EXE: exe,
          WIRECAT_ARGS: args.map((word) => `"${word.replaceAll('"', '\\"')}"`).join(" "),
          WIRECAT_KIND:
            "every" in when
              ? "every"
              : "once" in when
                ? "once"
                : "calendar" in when
                  ? "calendar"
                  : "daily" in when
                    ? "daily"
                    : "weekly",
          WIRECAT_MINUTES: "every" in when ? String(when.every) : "",
          WIRECAT_AT:
            "once" in when ? localStamp(when.once) : "daily" in when ? when.daily : "weekly" in when ? when.weekly : "",
          WIRECAT_DAY: "weekly" in when ? WINDOWS_DAYS[when.on] : "",
          WIRECAT_SLOTS:
            "calendar" in when
              ? when.calendar.map((slot) => `${slot.on ? WINDOWS_DAYS[slot.on] : ""}|${slot.at}`).join(";")
              : "",
          WIRECAT_NAME: schedule.name,
          WIRECAT_PATH: path,
        },
      )
    },
    remove: async (name) => {
      await powershell(
        "Unregister-ScheduledTask -TaskName $env:WIRECAT_NAME -TaskPath $env:WIRECAT_PATH -Confirm:$false",
        { WIRECAT_NAME: name, WIRECAT_PATH: path },
        true,
      )
    },
  }
}

export const timerFor = (app: AppIdentity, system: ServerSystem, env: NodeJS.ProcessEnv): Timer => {
  if (system.platform === "win32") return windowsTimer(app, system, env)
  if (!env.HOME) throw new CliError("configuration_error", "HOME is not set, so there is nowhere to put the timer")
  if (system.platform === "linux") return systemdTimer(app, system, env, env.HOME)
  if (system.platform === "darwin") return launchdTimer(app, system, env, env.HOME)
  throw new CliError(
    "validation_error",
    `${app.command} schedule knows Linux, macOS and Windows, not ${system.platform}`,
  )
}
