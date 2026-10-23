import { spawnSync } from "node:child_process"
import { accessSync, constants, realpathSync } from "node:fs"
import { delimiter, join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { type Installer, installerOf, updateCommand } from "@wirecat/cli-base/update"
import { DEFAULT_STEMMERS, type Stemmers } from "../search/stem.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath } from "../store/shared-config.js"
import { openStore } from "../store/store.js"
import { WIRECAT_TOOLS } from "./help/first-screen.js"
import {
  type PermissionAnswer,
  type Question,
  readSetupAnswers,
  type SetupAnswers,
  unanswered,
  writeSetupAnswers,
} from "./setup-answers.js"

/** The languages cli-core stems and has a dictionary for; each is one stemmer of its alphabet. */
export const LANGUAGES = [
  { name: "russian", code: "ru", label: "Russian", script: "cyrillic" },
  { name: "english", code: "en", label: "English", script: "latin" },
  { name: "spanish", code: "es", label: "Spanish", script: "latin" },
] as const
type Language = (typeof LANGUAGES)[number]["name"]

export interface FirstRunIo {
  ask: (prompt: string) => Promise<string>
  say: (text: string) => void
}

export interface FirstRun {
  command: string
  env: NodeJS.ProcessEnv
  io: FirstRunIo
  /** Every question, as `setup` asks them; otherwise only those no WireCat tool asked yet. */
  all?: boolean
  /** Set when `<PREFIX>_READ_ONLY` locks this process: it is stricter than any answer, so permissions are not asked. */
  readOnlyLock?: string
  /** Where tools are looked for and how one is installed; injected by tests. */
  installed?: (command: string) => boolean
  installer?: Installer
  install?: (argv: string[]) => boolean
}

/** The system's language, as the first locale variable set names it: `LC_ALL`, `LC_MESSAGES`, `LANG`, `LANGUAGE`. */
export const systemLanguage = (env: NodeJS.ProcessEnv): string | undefined => {
  const named = [env.LC_ALL, env.LC_MESSAGES, env.LANG, ...(env.LANGUAGE ?? "").split(":")]
    .map((value) => value?.trim())
    .find((value) => value && value !== "C" && value !== "POSIX" && !value.startsWith("C."))
  return (named ?? Intl.DateTimeFormat().resolvedOptions().locale).slice(0, 2).toLowerCase()
}

const stemmersOf = (languages: readonly Language[]): Stemmers => {
  const latin = LANGUAGES.filter(({ name, script }) => script === "latin" && languages.includes(name))
  return {
    cyrillic: languages.includes("russian") ? "russian" : "none",
    latin: latin.length ? latin.map(({ name }) => name).join(",") : "none",
  }
}

const languagesOf = (stemmers: Stemmers): Language[] =>
  LANGUAGES.filter(({ name }) => stemmers.cyrillic === name || stemmers.latin.split(",").includes(name)).map(
    ({ name }) => name,
  )

/** Numbers from a list, as `1,3` or `1 3`; Enter keeps `chosen`. */
const picked = (answer: string, count: number, chosen: number[]): number[] => {
  if (!answer.trim()) return chosen
  if (/^(none|-)$/i.test(answer.trim())) return []
  const numbers = answer
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > count))
    throw new CliError("validation_error", `choose numbers from 1 to ${count}, separated by commas`)
  return [...new Set(numbers)].sort((a, b) => a - b)
}

const onPath = (command: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? "").split(delimiter).some((folder) => {
    try {
      accessSync(join(folder, command), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

/** With the installer that installed this tool, its output on stderr so stdout stays data. */
const installWith = (argv: string[]): boolean =>
  spawnSync(argv[0] as string, argv.slice(1), { stdio: ["inherit", 2, 2] }).status === 0

const installerHere = () => {
  try {
    return installerOf(realpathSync(process.argv[1] ?? ""))
  } catch {
    return "unknown" as const
  }
}

const askLanguages = async ({ command, env, io }: FirstRun) => {
  const store = await openStore({ env })
  try {
    const saved = (await store.searchIndex.stemmers()) ?? undefined
    // A store already in use keeps the languages it was built with, so Enter changes nothing (RISK-1612).
    const inUse = saved !== undefined || (await store.accounts.accounts()).length > 0
    const system = systemLanguage(env)
    const ticked = inUse
      ? languagesOf(saved ?? DEFAULT_STEMMERS)
      : LANGUAGES.filter(({ code }) => code === "en" || code === system).map(({ name }) => name)
    const numbers = ticked.map((name) => LANGUAGES.findIndex((one) => one.name === name) + 1)
    io.say("Languages you write and speak — search finds every form of their words, and spellings speech mangles:")
    LANGUAGES.forEach(({ name, label }, at) => {
      io.say(`  ${at + 1}. ${label}${ticked.includes(name) ? " ✓" : ""}`)
    })
    const chosen = picked(await io.ask(`Numbers (${numbers.join(",")}): `), LANGUAGES.length, numbers)
    const next = stemmersOf(chosen.map((number) => (LANGUAGES[number - 1] as (typeof LANGUAGES)[number]).name))
    const before = saved ?? DEFAULT_STEMMERS
    if (inUse && before.cyrillic === next.cyrillic && before.latin === next.latin) return
    await store.searchIndex.saveStemmers(next)
    if (inUse) io.say(`Messages already stored keep their old word forms until \`${command} store reindex\`.`)
  } finally {
    await store.close()
  }
}

const askTools = async (run: FirstRun) => {
  const { command, env, io } = run
  const installed = run.installed ?? ((name: string) => onPath(name, env))
  const others = WIRECAT_TOOLS.filter((tool) => tool.command !== command)
  const missing = others.filter((tool) => !installed(tool.command))
  io.say("Other WireCat tools — they share this store, so one search finds everything:")
  for (const tool of others) io.say(`  ${installed(tool.command) ? "✓" : " "} ${tool.command} — ${tool.does}`)
  if (!missing.length) return
  missing.forEach((tool, at) => {
    io.say(`  ${at + 1}. install ${tool.command}`)
  })
  const chosen = picked(await io.ask("Numbers to install (none): "), missing.length, [])
  const installer = run.installer ?? installerHere()
  for (const number of chosen) {
    const tool = missing[number - 1] as (typeof missing)[number]
    const argv = updateCommand(installer, tool.package)
    if (!argv) {
      io.say(`Install ${tool.command} with \`npm install -g ${tool.package}\`.`)
      continue
    }
    io.say(`Installing ${tool.command}: ${argv.join(" ")}`)
    if (!(run.install ?? installWith)(argv)) io.say(`${tool.command} was not installed; run \`${argv.join(" ")}\`.`)
  }
}

const PERMISSION_CHOICES: { answer: PermissionAnswer; text: string }[] = [
  { answer: "readonly", text: "read only — search and read, never send or change anything" },
  { answer: "allow", text: "as now — each profile's own permissions" },
]

const askPermissions = async ({ io }: FirstRun, answers: SetupAnswers): Promise<PermissionAnswer> => {
  const now = answers.permissions ?? "allow"
  io.say("What may commands and agents do, in every WireCat tool?")
  PERMISSION_CHOICES.forEach(({ text }, at) => {
    io.say(`  ${at + 1}. ${text}`)
  })
  const current = Math.max(1, PERMISSION_CHOICES.findIndex(({ answer }) => answer === now) + 1)
  const [chosen] = picked(await io.ask(`Number (${current}): `), PERMISSION_CHOICES.length, [current])
  return (PERMISSION_CHOICES[(chosen ?? current) - 1] as (typeof PERMISSION_CHOICES)[number]).answer
}

/**
 * The questions every WireCat tool shares, asked once for all of them: the answers go to the shared config
 * file, the languages to the store. Only this, at a terminal, writes the permission answer.
 */
export const askSetupQuestions = async (run: FirstRun): Promise<Question[]> => {
  const path = sharedConfigPath(storePath(run.env), run.env)
  const answers = readSetupAnswers(path)
  const asking = (run.all ? (["languages", "tools", "permissions"] as Question[]) : unanswered(answers)).filter(
    (question) => question !== "permissions" || run.readOnlyLock === undefined,
  )
  for (const question of asking) {
    run.io.say("")
    if (question === "languages") {
      await askLanguages(run)
      writeSetupAnswers(path, { languages: true })
    } else if (question === "tools") {
      await askTools(run)
      writeSetupAnswers(path, { tools: true })
    } else writeSetupAnswers(path, { permissions: await askPermissions(run, answers) })
  }
  return asking
}
