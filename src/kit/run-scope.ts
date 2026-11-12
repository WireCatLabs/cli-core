import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { createProgram, type ProgramDefinition, type RunOptions, run } from "../cli/program.js"
import { findRun, runsDirFor } from "../runs/run.js"

export interface RunScopeCase {
  name: string
  /** Throws an `AssertionError` when the command does not run inside cli-core's run. */
  run(): Promise<void>
}

export interface RunScopeOptions {
  /** The CLI's own program definition, as its `run()` hands it to cli-core. */
  definition: ProgramDefinition
  /**
   * The words that run each remote command to success against the answering fake, by command path:
   * `{ "comments show": ["personal", "comments", "show", "c1"] }`. A write whose level is `ask` needs a profile that
   * allows it, or its refusal fails the case.
   */
  commands: Record<string, readonly string[]>
  /** Remote commands left out, each with its reason: one that listens until stopped, one that asks npm. */
  skip?: Record<string, string>
  /** What `run()` gets beside the streams: the keyring, and the fake that answers every request. */
  answering: () => RunOptions
  /** The same, with a fake that takes every request and never settles it, `neverAnswers` for an HTTP service. */
  silent: () => RunOptions
  /** The `--timeout` a silent run gets; 100 ms. */
  timeoutMs?: number
}

/** A `fetch` that never settles, not even on abort: only the run's own deadline can end the command. */
export const neverAnswers = ((): Promise<Response> => new Promise<Response>(() => {})) as typeof fetch

const GRACE_MS = 2000

interface Remote {
  path: string
  remote: string
  /** May answer `meta.complete: false` at its deadline, as a sync that stops in time does. */
  partial: boolean
}

/** Commander keeps it private; a group with an action of its own, as `doctor` beside `doctor reports`, runs too. */
const acts = (command: Command): boolean => (command as unknown as { _actionHandler?: unknown })._actionHandler != null

const remoteCommands = (program: Command, path: string[] = []): Remote[] =>
  program.commands.flatMap((command) => {
    const at = [...path, command.name()]
    const below = command.commands.length > 0 ? remoteCommands(command, at) : []
    if (command.commands.length > 0 && !acts(command)) return below
    const meta = metaOf(command)
    const remote = meta.effects?.remote
    const own = remote && remote !== "none" ? [{ path: at.join(" "), remote, partial: meta.partial === true }] : []
    return [...own, ...below]
  })

interface Ran {
  code: number
  out: string
  err: string
}

const within = async <T>(ms: number, what: string, body: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: what })), ms)
    timer.unref()
  })
  try {
    return await Promise.race([body, late])
  } finally {
    clearTimeout(timer)
  }
}

const parsed = (text: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(text.trim()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Cases that each remote command runs inside cli-core's run — `baseContext(command, resolveSettings).run(body)` — and
 * not beside it, so `--record` keeps a run named after the command (WC-LIFE-15); and that `--timeout` ends it when
 * its service never answers, a write as `outcome_unknown` (WC-LIFE-5, WC-LIFE-9). The recorded case is the one that
 * catches a command beside the run: `run()`'s own deadline still ends such a command on time. The first case fails
 * on a remote command with no words and no skip.
 */
export const runScopeCases = (options: RunScopeOptions): RunScopeCase[] => {
  const { definition, commands, skip = {}, timeoutMs = 100 } = options
  const { app } = definition

  const cli = async (argv: string[], given: RunOptions): Promise<Ran & { env: NodeJS.ProcessEnv }> => {
    const out: string[] = []
    const err: string[] = []
    const env = {
      ...process.env,
      ...given.env,
      [`${app.envPrefix}_STATE_DIR`]: mkdtempSync(join(tmpdir(), "run-scope-")),
    }
    const code = await run(argv, definition, {
      ...given,
      env,
      tty: false,
      streams: { data: (text) => out.push(text), diagnostic: (text) => err.push(text) },
    })
    return { code, out: out.join(""), err: err.join(""), env }
  }

  const machine = (words: readonly string[]) =>
    words.some((word) => word === "--json" || word.startsWith("--json=")) ? [...words] : [...words, "--json"]

  const recordedCase = (path: string, words: readonly string[]): RunScopeCase => ({
    name: `${path} runs in a recorded run named after it`,
    run: async () => {
      const ran = await within(
        GRACE_MS,
        `${path} did not end against the answering fake`,
        (async () => cli(["--record", ...machine(words)], options.answering()))(),
      )
      assert.equal(ran.code, 0, `${path} must succeed against the answering fake; it exited ${ran.code}: ${ran.err}`)
      const runId = (parsed(ran.out)?.meta as { run_id?: unknown } | undefined)?.run_id
      assert.equal(typeof runId, "string", `${path} answered without meta.run_id`)
      assert.doesNotMatch(String(runId), /-process-/, `${path} answered outside a run of its own: ${runId}`)
      const kept = findRun(runsDirFor(app, ran.env), String(runId))
      assert.ok(kept, `--record kept no run ${runId} for ${path}`)
      assert.equal(kept.metadata.command, path, `the run of ${path} is named ${kept.metadata.command}`)
    },
  })

  const timeoutCase = ({ path, remote, partial }: Remote, words: readonly string[]): RunScopeCase => {
    const expected = remote === "write" ? "outcome_unknown" : "timeout"
    return {
      name: `${path} ends in ${expected}${partial ? " or a partial answer" : ""} at --timeout when the service never answers`,
      run: async () => {
        const ran = await within(
          timeoutMs + GRACE_MS,
          `${path} was still running ${GRACE_MS} ms after its --timeout ${timeoutMs}ms`,
          cli(["--timeout", `${timeoutMs}ms`, ...machine(words)], options.silent()),
        )
        const answered = (parsed(ran.out)?.meta as { complete?: unknown } | undefined)?.complete
        if (partial && ran.code === 0 && answered === false) return
        const code = (parsed(ran.err)?.error as { code?: unknown } | undefined)?.code
        assert.equal(code, expected, `${path} against a silent service ended in ${String(code)}: ${ran.out}${ran.err}`)
      },
    }
  }

  const remote = remoteCommands(createProgram(definition))
  const coverage: RunScopeCase = {
    name: "every remote command has its words or a reason to skip it",
    run: async () => {
      const missing = remote.map(({ path }) => path).filter((path) => !(path in commands) && !(path in skip))
      assert.deepEqual(missing, [], `remote commands with no words in \`commands\` and no reason in \`skip\``)
      const known = new Set(remote.map(({ path }) => path))
      const stray = [...Object.keys(commands), ...Object.keys(skip)].filter((path) => !known.has(path))
      assert.deepEqual(stray, [], "paths in `commands` or `skip` that are not remote commands of this program")
    },
  }
  return [
    coverage,
    ...remote.flatMap((one) => {
      const words = commands[one.path]
      return words ? [recordedCase(one.path, words), timeoutCase(one, words)] : []
    }),
  ]
}
