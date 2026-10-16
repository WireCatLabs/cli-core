import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { FetchLike } from "@wirecat/cli-base/http"
import {
  type Installer,
  installerOf,
  latestVersion,
  runUpdate as runPackageManager,
  updateNotice as sharedNotice,
} from "@wirecat/cli-base/update"

/** npm, the clock, the terminal and the package manager as `<app> upgrade` sees them — faked in a test. */
export interface UpdateEnvironment {
  fetch?: FetchLike
  now?: () => number
  stderrIsTTY?: boolean
  scriptPath?: string
  /** Runs the update and answers its exit code; its output goes to stderr. */
  spawn?: (argv: string[]) => number
}

/** Words after which a line on stderr would land in a machine's answer, or would only repeat the command. */
export const QUIET_WORDS: readonly string[] = [
  "--help",
  "-h",
  "--version",
  "-V",
  "--json",
  "--jsonl",
  "--dry-run",
  "--timeout",
  "commands",
]

export interface AppUpdateOptions {
  packageName: string
  /** The command a person types: `max`, `memo`. */
  command: string
  version: string
  /**
   * The app's own file, as `import.meta.url`: its installer is read from where it really lives. cli-core's own
   * path would not do — a checkout or an npx cache puts the two apart.
   */
  entry: string
  /** The file the last answer from npm is kept in, in the app's state directory. */
  statePath: (env: NodeJS.ProcessEnv) => string
  /** The app's setting; a config that cannot be read turns the check off. */
  enabled: (env: NodeJS.ProcessEnv) => boolean
  /** Variables that turn it off besides `CI` and `NO_UPDATE_NOTIFIER`: `MAX_NO_UPDATE_CHECK`. */
  offVariables: readonly string[]
  /** `QUIET_WORDS` unless the app has its own; a word also counts as `--word=value`. */
  quietWords?: readonly string[]
}

export interface NoticeOptions {
  /** Whether stdout is a terminal; `process.stdout.isTTY` when not given. */
  tty?: boolean
  environment?: UpdateEnvironment
  env?: NodeJS.ProcessEnv
}

/** What `upgrade` and the daily notice need of one app: its installer, npm's latest version, the update itself. */
export const appUpdate = (app: AppUpdateOptions) => {
  const quietWords = app.quietWords ?? QUIET_WORDS
  const installer = ({ scriptPath }: UpdateEnvironment = {}): Installer =>
    installerOf(scriptPath ?? realpathSync(fileURLToPath(app.entry)))
  const enabled = (env: NodeJS.ProcessEnv) => {
    try {
      return app.enabled(env)
    } catch {
      return false
    }
  }
  return {
    installer,
    latest: (environment: UpdateEnvironment = {}) =>
      latestVersion(app.packageName, environment.fetch ?? fetch, { timeoutMs: 3000 }),
    /** The package manager's output goes to stderr, so stdout stays one result. */
    runUpdate: (argv: string[], environment: UpdateEnvironment = {}): number =>
      environment.spawn ? environment.spawn(argv) : runPackageManager(argv),
    /**
     * The daily "a newer version exists" line, or `undefined`. Started beside the command and awaited
     * after it, so asking npm costs the command nothing; any failure is silence, never an error.
     */
    updateNotice: (
      argv: readonly string[],
      { tty, environment = {}, env = process.env }: NoticeOptions = {},
    ): Promise<string | undefined> => {
      try {
        const delimiter = argv.indexOf("--")
        const options = argv.slice(0, delimiter < 0 ? undefined : delimiter)
        const quiet = options.some((word) =>
          quietWords.some((quietWord) => word === quietWord || word.startsWith(`${quietWord}=`)),
        )
        if (quiet) return Promise.resolve(undefined)
        const pretty = !argv.includes("--json") && !argv.includes("--jsonl") && (tty ?? process.stdout.isTTY === true)
        return sharedNotice({
          argv,
          packageName: app.packageName,
          command: app.command,
          version: app.version,
          statePath: app.statePath(env),
          fetch: environment.fetch ?? fetch,
          ...(environment.now ? { now: environment.now } : {}),
          format: pretty ? "pretty" : "json",
          stderrIsTTY: environment.stderrIsTTY ?? process.stderr.isTTY === true,
          quiet: argv.includes("--quiet"),
          enabled: enabled(env),
          installer: installer(environment),
          env,
          offVariables: app.offVariables,
        })
      } catch {
        return Promise.resolve(undefined)
      }
    },
  }
}

export type AppUpdate = ReturnType<typeof appUpdate>
