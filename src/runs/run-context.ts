import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { isContentKey } from "@wirecat/cli-base/standards"
import type { Argument, Command, Option } from "commander"
import { BARE_PHONE, INTERNATIONAL_PHONE } from "./error-detail.js"
import type { RunContext } from "./run.js"
import { secretNamed, withoutSecrets } from "./secrets.js"

export const REDACTED = "[redacted]"

/** Which coding agent started the process, and its session when the agent names one. Keys as written in run.json. */
export interface RunAgent {
  kind: string
  session_id: string | null
  /** Set, and only `true`, when a chat message started the agent's turn; who sent it is never kept. */
  from_chat?: true
  /** The MCP client that made the call, as it named itself; `id` is `clientHash` of an OAuth client's id. */
  client?: RunClient
}

export interface RunClient {
  name: string
  version?: string
  id?: string
}

/** `record_input`: the words typed are kept (`true`), masked (`false`), or kept only in a run that failed. */
export type RecordInput = boolean | "failed"

/**
 * Whether a run that succeeds is kept. Every run is, unless the config says `record: false` — then only failures —
 * or WireCat Desktop ran the command for its own pages (`WIRECAT_CALLER=desktop`), or the command runs until stopped
 * (`watch`, `serve`, `mcp`): those two only on `--record`. An MCP call is the caller's run, not Desktop's.
 */
export const keepsSuccess = ({
  record,
  fromFlag,
  env,
  caller,
  persistent = false,
}: {
  record: boolean
  fromFlag: boolean
  env: NodeJS.ProcessEnv
  caller?: RunCaller | undefined
  persistent?: boolean
}): boolean => {
  if (!record) return false
  if (fromFlag) return true
  if (persistent) return false
  return caller !== undefined || viaOf(env) !== "desktop"
}

/** How the run was asked for: typed or scripted, an MCP client on stdio or over HTTP, or WireCat Desktop. */
export type RunVia = "cli" | "mcp-stdio" | "mcp-http" | "desktop"

/** The MCP call a run answered. `connection_id` groups the calls of one connection when no agent session does. */
export interface RunMcp {
  tool: string
  request_id?: string
  connection_id?: string
  /** The every-profile server passed the call on; the caller is the one it named. */
  proxied?: true
}

/** Who asked for a run, worked out by whoever received the call; it wins over the process's environment. */
export interface RunCaller {
  via: RunVia
  agent?: RunAgent
  mcp?: RunMcp
}

const calls = new AsyncLocalStorage<RunCaller>()

/**
 * Runs one MCP call with its caller known, so every run opened under it names that caller: the command's own, and
 * the connection a server opens for it, which runs under the server's context.
 */
export const withCaller = <T>(caller: RunCaller, work: () => T): T => calls.run(caller, work)

export const currentCaller = (): RunCaller | undefined => calls.getStore()

/** An OAuth client id is a bearer of sorts: a run keeps eight hex characters of its SHA-256, enough to tell apps apart. */
export const clientHash = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 8)

/** `WIRECAT_CALLER=desktop` is set by WireCat Desktop on the commands it runs for its own pages. */
export const viaOf = (env: NodeJS.ProcessEnv): RunVia => (env.WIRECAT_CALLER?.trim() === "desktop" ? "desktop" : "cli")

/**
 * The agent is read from what each one sets in the processes it starts: Claude Code `CLAUDECODE` and
 * `CLAUDE_CODE_SESSION_ID`, Codex `CODEX_THREAD_ID`, OpenCode `OPENCODE` and `OPENCODE_SESSION_ID`, Hermes
 * `AI_AGENT=hermes-agent` and `HERMES_SESSION_ID`, Gemini CLI `GEMINI_CLI`, Cursor `CURSOR_AGENT`, OpenClaw
 * `OPENCLAW_SHELL=exec` — the last three give their commands no session id. `AI_AGENT` (Claude Code, OpenCode, Hermes)
 * carries a version, `claude-code_2-1-296_agent`, so only the name before it is kept.
 */
export const agentOf = (env: NodeJS.ProcessEnv): RunAgent | undefined => {
  const named = env.AI_AGENT?.trim().split("_")[0]
  const kind =
    (named && plainWord(named) ? named.toLowerCase() : undefined) ??
    (env.CLAUDECODE ? "claude-code" : undefined) ??
    (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_SANDBOX ? "codex" : undefined) ??
    (env.GEMINI_CLI ? "gemini-cli" : undefined) ??
    (env.OPENCODE ? "opencode" : undefined) ??
    (env.CURSOR_AGENT ? "cursor" : undefined) ??
    // Only `exec` is the agent's own command: OpenClaw also sets `tui-local` for what the owner types in its TUI.
    (env.OPENCLAW_SHELL?.trim() === "exec" ? "openclaw" : undefined)
  if (!kind) return undefined
  const session = sessionOf(kind, env)
  return {
    kind,
    session_id: session && SESSION.test(session) ? session : null,
    // OpenClaw passes the sender and chat ids of a chat-started run in this variable; only its presence is kept.
    ...(kind === "openclaw" && env.OPENCLAW_CHANNEL_CONTEXT?.trim() ? { from_chat: true as const } : {}),
  }
}

const SESSION = /^[A-Za-z0-9._:-]{1,128}$/

const SESSION_VARIABLE: Readonly<Record<string, string>> = {
  "claude-code": "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
  opencode: "OPENCODE_SESSION_ID",
  "hermes-agent": "HERMES_SESSION_ID",
}

const sessionOf = (kind: string, env: NodeJS.ProcessEnv): string | undefined => {
  const variable = SESSION_VARIABLE[kind]
  return (variable === undefined ? undefined : env[variable]?.trim()) || undefined
}

const plainWord = (word: string) => /^[A-Za-z][A-Za-z0-9.-]{0,39}$/.test(word)

export interface MaskedArgv {
  /** The words after the binary; a secret is `[redacted]`, and with `keep` off so is every value that may be content. */
  argv: string[]
  /** The first word that names no command where one was expected. */
  unknownCommand?: string
}

const secretInputs = new WeakSet<Option | Argument | Command>()

/**
 * Marks an option or argument whose value a run record never keeps, whatever the owner's `record_input`; on a command,
 * every word typed after it that is not an option.
 */
export const secretInput = <T extends Option | Argument | Command>(input: T): T => {
  secretInputs.add(input)
  return input
}

// A password inside a URL, or one unbroken run of 40 token characters, is a credential wherever it was typed.
const secretShaped = (word: string): boolean =>
  /:\/\/[^/@\s:]+:[^/@\s]+@/.test(word) || /(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{40,}($|[^A-Za-z0-9_-])/.test(word)

// Messaging CLIs promise a phone number reaches no log, so it goes even from text the record otherwise keeps.
const withoutPhones = (word: string): string =>
  word.replace(new RegExp(INTERNATIONAL_PHONE, "g"), REDACTED).replace(new RegExp(BARE_PHONE, "g"), `$1${REDACTED}`)

/**
 * The command line for a run record. With `keep` (the owner's `record_input`, on unless turned off) every word stays
 * as typed except a secret: a value of an input marked `secretInput` or named for one (`--token`), a word shaped
 * like a credential, and a phone number inside any word. With `keep` off, command words, flag names and the profile stay; a value stays only when its
 * shape cannot be somebody's words — a number short of a phone's length, a duration, a date, `true`, one of the
 * option's declared choices — and its option or argument is not named for content (`--text`, `<phone>`). Anything
 * else, a positional after `--` or an argument no command declares, is `[redacted]`: a chat is often typed by title.
 */
export const maskArgv = (program: Command, words: readonly string[], { keep = false } = {}): MaskedArgv => {
  const argv: string[] = []
  let unknownCommand: string | undefined
  let current = program
  let positional = 0
  let profileSeen = false
  let lost = false

  const raw = (word: string) => (keep && !secretShaped(word) ? withoutPhones(withoutSecrets(word, REDACTED)) : REDACTED)
  const keptValue = (name: string, value: string, input?: Option | Argument): string =>
    keep
      ? (input && secretInputs.has(input)) || secretNamed(name)
        ? REDACTED
        : raw(value)
      : maskedValue(name, value, input?.argChoices)

  const optionFor = (flag: string): Option | undefined => {
    for (let at: Command | null = current; at; at = at.parent) {
      const found = at.options.find((option) => option.long === flag || option.short === flag)
      if (found) return found
    }
    return undefined
  }

  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string
    if (word === "--") {
      argv.push("--")
      for (let after = at + 1; after < words.length; after++) argv.push(raw(words[after] as string))
      break
    }
    if (word.startsWith("-") && word.length > 1 && !NUMBER.test(word)) {
      const equals = word.indexOf("=")
      const flag = equals > 0 ? word.slice(0, equals) : word
      if (!/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag)) {
        argv.push(raw(word))
        continue
      }
      const option = optionFor(flag)
      const name = option?.attributeName() ?? flag.replace(/^-+/, "")
      if (equals > 0) {
        argv.push(`${flag}=${keptValue(name, word.slice(equals + 1), option)}`)
        continue
      }
      argv.push(flag)
      if (!option && keep && secretNamed(name) && words[at + 1] !== undefined && !words[at + 1]?.startsWith("-")) {
        at += 1
        argv.push(REDACTED)
        continue
      }
      if (!option || !(option.required || option.optional)) continue
      const takes = (next: string | undefined) =>
        next !== undefined && (option.required || !next.startsWith("-") || NUMBER.test(next))
      if (takes(words[at + 1])) {
        at += 1
        argv.push(keptValue(name, words[at] as string, option))
        while (option.variadic && words[at + 1] !== undefined && !(words[at + 1] as string).startsWith("-")) {
          at += 1
          argv.push(keptValue(name, words[at] as string, option))
        }
      }
      continue
    }
    if (!lost && positional === 0) {
      const sub = current.commands.find((one) => one.name() === word || one.aliases().includes(word))
      if (sub) {
        argv.push(word)
        current = sub
        continue
      }
      if (current === program && !profileSeen) {
        profileSeen = true
        argv.push(
          keep ? raw(word) : PROFILE.test(word) && withoutPhones(withoutSecrets(word)) === word ? word : REDACTED,
        )
        continue
      }
      if (current.commands.length > 0 && current.registeredArguments.length === 0) {
        lost = true
        unknownCommand = commandLike(word)
        argv.push(keep ? raw(word) : unknownCommand)
        continue
      }
    }
    const declared = lost ? undefined : current.registeredArguments
    const argument = declared?.[Math.min(positional, declared.length - 1)]
    positional += 1
    argv.push(secretInputs.has(current) ? REDACTED : argument ? keptValue(argument.name(), word, argument) : raw(word))
  }
  return { argv, ...(unknownCommand === undefined ? {} : { unknownCommand }) }
}

const NUMBER = /^-?\d+(\.\d+)?$/
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A mistyped command word is kept so the typo can be seen; anything shaped like a sentence or an address is not. */
const commandLike = (word: string): string =>
  /^[a-z][a-z0-9-]{0,31}$/i.test(word) && withoutSecrets(word) === word ? word : REDACTED

const maskedValue = (name: string, value: string, choices: readonly string[] | undefined): string => {
  if (isContentKey(name)) return REDACTED
  if (name === "profile") return PROFILE.test(value) ? value : REDACTED
  if (name === "json" || name === "fields") return /^[a-z0-9_.,]{1,200}$/.test(value) ? value : REDACTED
  if (choices?.includes(value)) return value
  return safeShape(value) ? value : REDACTED
}

// A positive run of eleven or more digits can be a phone number written without its "+"; ids that long are negative
// (chats and channels) and stay.
const safeShape = (value: string): boolean =>
  (NUMBER.test(value) && !/^\d{11,}$/.test(value)) ||
  /^\d+(ms|s|m|h|d|w)$/.test(value) ||
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) ||
  value === "true" ||
  value === "false"

/**
 * A run's context from the parsed program: `max messages list` and its words, or the word that named nothing. A CLI
 * that calls `recorded` or `startRecording` for a command of its own passes this as `context`; without it the run
 * keeps no command line and no agent.
 */
export const runContextOf = ({
  bin,
  command,
  program,
  argv,
  env,
  recordInput = false,
  caller,
}: {
  bin: string
  /** The run's own name, `messages list` or `mcp messages list`; empty when no command was recognised. */
  command: string
  program?: Command
  argv?: readonly string[]
  env: NodeJS.ProcessEnv
  /** The owner's `record_input`; left out, every value that may be content is masked. `failed` keeps them only then. */
  recordInput?: RecordInput | undefined
  /** Who asked, when the receiver knows better than the environment: an MCP call. */
  caller?: RunCaller | undefined
}): RunContext & { argvIfFailed?: string[] } => {
  const masked = program && argv ? maskArgv(program, argv, { keep: recordInput === true }) : undefined
  const ifFailed = program && argv && recordInput === "failed" ? maskArgv(program, argv, { keep: true }) : undefined
  const agent = caller ? caller.agent : agentOf(env)
  return {
    cliCommand: command ? `${bin} ${command}` : bin,
    ...(masked ? { argv: masked.argv } : {}),
    ...(ifFailed ? { argvIfFailed: ifFailed.argv } : {}),
    ...(masked?.unknownCommand === undefined ? {} : { unknownCommand: masked.unknownCommand }),
    ...(agent ? { agent } : {}),
    via: caller?.via ?? viaOf(env),
    ...(caller?.mcp ? { mcp: caller.mcp } : {}),
  }
}
