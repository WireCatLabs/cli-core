import { spawnSync } from "node:child_process"
import { accessSync, constants, realpathSync } from "node:fs"
import { delimiter, join } from "node:path"
import { type Installer, installerOf, updateCommand } from "@wirecat/cli-base/update"
import { LANGUAGES, type Language } from "../search/languages.js"
import { DEFAULT_STEMMERS, type Stemmers } from "../search/stem.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath } from "../store/shared-config.js"
import { openStore } from "../store/store.js"
import { readSecret } from "../terminal/prompt.js"
import { WIRECAT_TOOLS } from "./help/first-screen.js"
import { buildStems } from "./messenger/store-maintenance-command.js"
import {
  type PermissionAnswer,
  QUESTIONS,
  type Question,
  readSetupAnswers,
  type SetupAnswers,
  unanswered,
  writeSetupAnswers,
} from "./setup-answers.js"

/** The languages cli-core stems and has a dictionary for; each is one stemmer of its alphabet. */

export interface FirstRunIo {
  ask: (prompt: string) => Promise<string>
  say: (text: string) => void
}

export interface FirstRun {
  command: string
  env: NodeJS.ProcessEnv
  io: FirstRunIo
  /** `AppIdentity.contentLanguages`: ticked on a new store in place of English and the system's language. */
  contentLanguages?: readonly string[] | undefined
  /** Every question, as `setup` asks them; otherwise only those no WireCat tool asked yet. */
  all?: boolean
  /** Where tools are looked for and how one is installed; injected by tests. */
  installed?: (command: string) => boolean
  installer?: Installer
  install?: (argv: string[]) => boolean
}

/** Commands that run without first-run questions: they serve agents, help, or open the store themselves. */
const SKIPPED = new Set(["help", "guide", "completion", "mcp", "serve", "server", "update", "store"])

/**
 * Only a person at a terminal is asked. An agent in a real terminal passes every terminal check and would wait on
 * the question forever; a process locked read-only must write nothing, and every answer writes something.
 */
export const asksAtStart = (start: {
  headless: boolean
  terminal: boolean
  env: NodeJS.ProcessEnv
  readOnlyLock: string | undefined
  path: readonly string[]
}): boolean =>
  !start.headless &&
  start.terminal &&
  !start.env.AI_AGENT &&
  !start.env.CLAUDECODE &&
  start.readOnlyLock === undefined &&
  !SKIPPED.has(start.path[0] ?? "")

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

/** Numbers from a list, as `1,3` or `1 3`; Enter keeps `chosen`. A wrong answer is asked again, then left as it was. */
const choose = async (io: FirstRunIo, prompt: string, count: number, chosen: number[]): Promise<number[]> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await io.ask(prompt)).trim()
    if (!answer) return chosen
    if (/^(none|-)$/i.test(answer)) return []
    const numbers = answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= count))
      return [...new Set(numbers)].sort((a, b) => a - b)
    io.say(`Choose numbers from 1 to ${count}, separated by commas.`)
  }
  return chosen
}

const yes = async (io: FirstRunIo, prompt: string) => /^y(es)?$/i.test((await io.ask(prompt)).trim())

const onPath = (command: string, env: NodeJS.ProcessEnv): boolean => {
  const names = process.platform === "win32" ? [".cmd", ".exe", ""].map((ending) => command + ending) : [command]
  return (env.PATH ?? env.Path ?? "").split(delimiter).some((folder) =>
    names.some((name) => {
      try {
        accessSync(join(folder, name), process.platform === "win32" ? constants.F_OK : constants.X_OK)
        return true
      } catch {
        return false
      }
    }),
  )
}

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

const suggested = (env: NodeJS.ProcessEnv, contentLanguages: readonly string[] | undefined): Language[] => {
  const own = LANGUAGES.filter(({ code }) => contentLanguages?.includes(code))
  const system = systemLanguage(env)
  return (own.length ? own : LANGUAGES.filter(({ code }) => code === "en" || code === system)).map(({ name }) => name)
}

const askLanguages = async ({ command, env, io, contentLanguages }: FirstRun) => {
  const store = await openStore({ env })
  let rebuild = false
  try {
    const saved = (await store.searchIndex.stemmers()) ?? undefined
    // A store already in use keeps the languages it was built with, so Enter changes nothing (RISK-1612).
    const inUse = saved !== undefined || (await store.accounts.accounts()).length > 0
    const ticked = inUse ? languagesOf(saved ?? DEFAULT_STEMMERS) : suggested(env, contentLanguages)
    const numbers = ticked.map((name) => LANGUAGES.findIndex((one) => one.name === name) + 1)
    io.say("Languages you write and speak — search finds every form of their words, and spellings speech mangles:")
    LANGUAGES.forEach(({ name, label }, at) => {
      io.say(`  ${at + 1}. ${label}${ticked.includes(name) ? " ✓" : ""}`)
    })
    const chosen = await choose(io, `Numbers (${numbers.join(",")}): `, LANGUAGES.length, numbers)
    const next = stemmersOf(chosen.map((number) => (LANGUAGES[number - 1] as (typeof LANGUAGES)[number]).name))
    const before = saved ?? DEFAULT_STEMMERS
    if (inUse && before.cyrillic === next.cyrillic && before.latin === next.latin) return
    // Word search refuses until stems built by the old choice are rebuilt, so the change and the rebuild go together.
    if (
      inUse &&
      !(await yes(
        io,
        "Rebuild the word forms of every stored message now? Word search waits for it; a large store takes minutes. [y/N] ",
      ))
    ) {
      io.say(`Languages kept as they were; \`${command} setup\` asks again.`)
      return
    }
    await store.searchIndex.saveStemmers(next)
    rebuild = inUse
  } finally {
    await store.close()
  }
  if (!rebuild) return
  const database = await openCache(storePath(env))
  try {
    buildStems(database, (note) => io.say(`  ${note}`), { force: true })
  } finally {
    database.close()
  }
}

const askTools = async (run: FirstRun) => {
  const { command, env, io } = run
  const installed = run.installed ?? ((name: string) => onPath(name, env))
  const others = WIRECAT_TOOLS.filter((tool) => tool.command !== command)
  const missing = others.filter((tool) => !installed(tool.command))
  io.say("Other WireCat tools — they share this store, so one search finds everything:")
  for (const tool of others) {
    const at = missing.indexOf(tool)
    io.say(`  ${at < 0 ? "✓ " : `${at + 1}.`} ${tool.command} — ${tool.does}`)
  }
  if (!missing.length) return
  const chosen = await choose(io, "Numbers to install (none): ", missing.length, [])
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
  { answer: "readonly", text: "read only — search and read; nothing sends or changes" },
  { answer: "allow", text: "read and write — as each profile's permissions allow" },
]

const askPermissions = async ({ io }: FirstRun, answers: SetupAnswers): Promise<PermissionAnswer> => {
  const now = answers.permissions ?? "allow"
  const current = Math.max(1, PERMISSION_CHOICES.findIndex(({ answer }) => answer === now) + 1)
  io.say("Read only, or read and write? The same for you, scripts and agents over MCP, in every WireCat tool:")
  PERMISSION_CHOICES.forEach(({ text }, at) => {
    io.say(`  ${at + 1}. ${text}`)
  })
  const [chosen = current] = await choose(io, `Number (${current}): `, PERMISSION_CHOICES.length, [current])
  return (PERMISSION_CHOICES[chosen - 1] as (typeof PERMISSION_CHOICES)[number]).answer
}

/** A section another tool wrote wrongly is asked again and written over, rather than stopping the command. */
const answersAt = (path: string): SetupAnswers => {
  try {
    return readSetupAnswers(path)
  } catch {
    return {}
  }
}

/**
 * The questions every WireCat tool shares, asked once for all of them: the answers go to the shared config
 * file, the languages to the store. Only this, at a terminal, writes the permission answer.
 */
export const askSetupQuestions = async (run: FirstRun): Promise<Question[]> => {
  const path = sharedConfigPath(storePath(run.env), run.env)
  const answers = answersAt(path)
  const asking = run.all ? [...QUESTIONS] : unanswered(answers)
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

/**
 * The first-run step a tool runs before each command: asks when `asksAtStart` says so, and lets the command run
 * whatever happens to the questions. `setup` asks all three again, since a refusal sends the owner there.
 * A tool that builds its own program gets it from `startCli` as `entry.atStart`.
 */
export const setupAtStart = async (start: {
  command: string
  env: NodeJS.ProcessEnv
  contentLanguages?: readonly string[] | undefined
  path: readonly string[]
  headless: boolean
  readOnlyLock?: string | undefined
  input?: NodeJS.ReadableStream & { isTTY?: boolean }
  terminal?: boolean
}): Promise<void> => {
  const input = start.input ?? process.stdin
  const terminal = start.terminal ?? (input.isTTY === true && process.stderr.isTTY === true)
  if (!asksAtStart({ ...start, terminal, readOnlyLock: start.readOnlyLock })) return
  await askSetupQuestions({
    command: start.command,
    env: start.env,
    contentLanguages: start.contentLanguages,
    all: start.path[0] === "setup",
    io: {
      ask: (prompt) => readSecret(prompt, { input, echo: true }),
      say: (text) => process.stderr.write(`${text}\n`),
    },
  }).catch((error: unknown) => {
    process.stderr.write(
      `setup questions skipped: ${error instanceof Error ? error.message : String(error)} — \`${start.command} setup\` asks them again\n`,
    )
  })
}
