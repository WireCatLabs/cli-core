import { isContentKey } from "@wirecat/cli-base/standards"
import type { Command, Option } from "commander"
import type { RunContext } from "./run.js"

export const REDACTED = "[redacted]"

/** Which coding agent started the process, and its session when the agent names one. Keys as written in run.json. */
export interface RunAgent {
  kind: string
  session_id: string | null
  /** Set, and only `true`, when a chat message started the agent's turn; who sent it is never kept. */
  from_chat?: true
}

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
  /** The words after the binary, every value that may be content or a secret replaced by `[redacted]`. */
  argv: string[]
  /** The first word that names no command where one was expected. */
  unknownCommand?: string
}

/**
 * The command line as typed, safe to keep. Command words, flag names and the profile stay; a value stays only when
 * its shape cannot be somebody's words — a number short of a phone's length, a duration, a date, `true`, one of the
 * option's declared choices — and its option or argument is not named for content (`--text`, `<phone>`). Anything
 * else, a positional after `--` or an argument no command declares, is `[redacted]`: a chat is often typed by title.
 */
export const maskArgv = (program: Command, words: readonly string[]): MaskedArgv => {
  const argv: string[] = []
  let unknownCommand: string | undefined
  let current = program
  let positional = 0
  let profileSeen = false
  let lost = false

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
      for (let after = at + 1; after < words.length; after++) argv.push(REDACTED)
      break
    }
    if (word.startsWith("-") && word.length > 1 && !NUMBER.test(word)) {
      const equals = word.indexOf("=")
      const flag = equals > 0 ? word.slice(0, equals) : word
      if (!/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag)) {
        argv.push(REDACTED)
        continue
      }
      const option = optionFor(flag)
      const name = option?.attributeName() ?? flag.replace(/^-+/, "")
      if (equals > 0) {
        argv.push(`${flag}=${maskedValue(name, word.slice(equals + 1), option?.argChoices)}`)
        continue
      }
      argv.push(flag)
      if (!option || !(option.required || option.optional)) continue
      const takes = (next: string | undefined) =>
        next !== undefined && (option.required || !next.startsWith("-") || NUMBER.test(next))
      if (takes(words[at + 1])) {
        at += 1
        argv.push(maskedValue(name, words[at] as string, option.argChoices))
        while (option.variadic && words[at + 1] !== undefined && !(words[at + 1] as string).startsWith("-")) {
          at += 1
          argv.push(maskedValue(name, words[at] as string, option.argChoices))
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
        argv.push(PROFILE.test(word) ? word : REDACTED)
        continue
      }
      if (current.commands.length > 0 && current.registeredArguments.length === 0) {
        lost = true
        unknownCommand = commandLike(word)
        argv.push(unknownCommand)
        continue
      }
    }
    const declared = lost ? undefined : current.registeredArguments
    const argument = declared?.[Math.min(positional, declared.length - 1)]
    positional += 1
    argv.push(argument ? maskedValue(argument.name(), word, argument.argChoices) : REDACTED)
  }
  return { argv, ...(unknownCommand === undefined ? {} : { unknownCommand }) }
}

const NUMBER = /^-?\d+(\.\d+)?$/
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A mistyped command word is kept so the typo can be seen; anything shaped like a sentence or an address is not. */
const commandLike = (word: string): string => (/^[a-z][a-z0-9-]{0,31}$/i.test(word) ? word : REDACTED)

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

/** A run's context from the parsed program: `max messages list` and its masked words, or the word that named nothing. */
export const runContextOf = ({
  bin,
  command,
  program,
  argv,
  env,
}: {
  bin: string
  /** The run's own name, `messages list` or `mcp messages list`; empty when no command was recognised. */
  command: string
  program?: Command
  argv?: readonly string[]
  env: NodeJS.ProcessEnv
}): RunContext => {
  const masked = program && argv ? maskArgv(program, argv) : undefined
  const agent = agentOf(env)
  return {
    cliCommand: command ? `${bin} ${command}` : bin,
    ...(masked ? { argv: masked.argv } : {}),
    ...(masked?.unknownCommand === undefined ? {} : { unknownCommand: masked.unknownCommand }),
    ...(agent ? { agent } : {}),
  }
}
