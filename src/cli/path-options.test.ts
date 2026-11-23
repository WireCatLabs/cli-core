import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { captureStreams, resolvePaths } from "@wirecat/cli-base"
import type { ErrorObject } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { wirecatDirectory } from "../store/path.js"
import { app, sharedProgram } from "../testing/shared-program.js"
import { addTrackerCommands } from "../tracker/cli/index.js"
import { TRACKER_WRITES } from "../tracker/writer.js"
import { fileConflictsCommand } from "./documents/file-conflicts.js"
import { addFileEditCommands } from "./documents/file-edit.js"
import { fileMirrorsCommand } from "./documents/file-mirrors.js"
import { addDocumentHistoryCommands } from "./documents/history.js"
import {
  inStoreBackups,
  isLocalPathArgument,
  isLocalPathOption,
  isNotLocalPath,
  looksLikePath,
  notLocalPaths,
  refuseAgentPaths,
} from "./path-options.js"
import { createProgram, run } from "./program.js"
import { absolutePaths } from "./relay-route.js"

const sandbox = () => {
  const home = mkdtempSync(join(tmpdir(), "path-options-"))
  const env = { HOME: home, USERPROFILE: home }
  const store = join(wirecatDirectory(env), "wirecat.db")
  return { home, env: { ...env, MESSAGING_STORE: store }, store }
}

/** `export --output <file> --input <file...> [dir]`, with the values given, as preAction would see them. */
const parsed = (args: string[], shape: (command: Command) => Command = (one) => one) => {
  const root = new Command("chat").exitOverride()
  let seen: Command | undefined
  const leaf = shape(
    root
      .command("export")
      .option("--output <file>", "where")
      .option("--input <file...>", "what")
      .option("--title <path>", "a remote path")
      .option("--archive <dir>", "where else", "/proc/self")
      .argument("[dir]", "a folder"),
  ).action(function (this: Command) {
    seen = this
  })
  root.parse(["export", ...args], { from: "user" })
  return seen ?? leaf
}

const refusal = (args: string[], env: NodeJS.ProcessEnv, shape?: (command: Command) => Command) => {
  try {
    refuseAgentPaths(parsed(args, shape), app, env)
    return undefined
  } catch (error) {
    return error as Error & { code?: string }
  }
}

describe("refuseAgentPaths: one check for every path an MCP call names", () => {
  it("refuses a credential folder, by option and by argument, and lets an ordinary folder through", () => {
    const { home, env } = sandbox()
    const elsewhere = mkdtempSync(join(tmpdir(), "path-options-out-"))

    expect(refusal(["--output", join(home, ".ssh", "id_new")], env)).toMatchObject({ code: "permission_error" })
    expect(refusal([join(home, ".config", "autostart")], env)?.message).toMatch(/^<dir> /)
    expect(refusal(["--input", join(elsewhere, "a"), join(home, ".aws", "credentials")], env)?.message).toMatch(
      /^--input /,
    )
    expect(refusal(["--output", join(elsewhere, "copy.db"), elsewhere], env)).toBeUndefined()
    expect(refusal(["--output", "-"], env)).toBeUndefined()
  })

  it("refuses through a link and through ..", () => {
    const { home, env } = sandbox()
    const elsewhere = mkdtempSync(join(tmpdir(), "path-options-out-"))
    mkdirSync(join(home, ".ssh"), { recursive: true })
    symlinkSync(join(home, ".ssh"), join(elsewhere, "keys"))

    expect(refusal(["--output", join(elsewhere, "keys", "id_new")], env)).toMatchObject({ code: "permission_error" })
    expect(refusal(["--output", `${elsewhere}/inner/../../${basename(home)}/.gnupg/x`], env)).toBeDefined()
  })

  it("refuses this tool's own folders, another WireCat tool's, the WireCat folder and the store", () => {
    const { env, store } = sandbox()
    const own = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })
    const other = resolvePaths({ appName: "tg-cli", prefix: "TG", env })

    for (const place of [
      join(own.config, "config.json"),
      join(own.state, "schedules", "x.json"),
      join(other.config, "session"),
      join(wirecatDirectory(env), "models", "x"),
      store,
      `${store}-wal`,
      "/proc/self/environ",
    ])
      expect(refusal(["--output", place], env), place).toMatchObject({ code: "permission_error" })
  })

  it("leaves out a default the command chose, an input marked not local, and a URL", () => {
    const { home, env } = sandbox()
    const remote = join(home, ".ssh", "on-the-disk")

    expect(refusal([], env)).toBeUndefined()
    expect(refusal(["--archive", "/proc/self"], env)).toBeDefined()
    expect(refusal(["--title", remote], env, (one) => notLocalPaths(one, "title"))).toBeUndefined()
    expect(refusal(["--output", "https://example.com/.ssh/x"], env)).toBeUndefined()
  })

  it("lets a command marked for it name the store's backups folder, and nothing else of the WireCat folder", () => {
    const { env, store } = sandbox()
    const backups = join(dirname(store), "backups")
    const marked = (one: Command) => inStoreBackups(one, "output")
    const elsewhere = mkdtempSync(join(tmpdir(), "path-options-out-"))
    mkdirSync(backups, { recursive: true })
    mkdirSync(join(env.HOME, ".ssh"), { recursive: true })
    symlinkSync(join(env.HOME, ".ssh"), join(backups, "keys"))

    expect(refusal(["--output", join(backups, "copy.db")], env, marked)).toBeUndefined()
    expect(refusal(["--output", join(backups, "copy.db")], env)).toBeDefined()
    expect(refusal(["--output", store], env, marked)).toBeDefined()
    expect(refusal(["--output", join(backups, "keys", "id")], env, marked)).toBeDefined()
    expect(refusal(["--output", join(backups, "..", "wirecat.db")], env, marked)).toBeDefined()
    expect(refusal(["--output", join(elsewhere, "copy.db")], env, marked)).toBeUndefined()
  })
})

it("serve makes only local paths absolute against the client's folder, not a folder's title", () => {
  const root = notLocalPaths(new Command("chat"), "folder")
  let seen: Command | undefined
  root
    .command("show")
    .argument("<folder>")
    .option("--output <file>")
    .action(function (this: Command) {
      seen = this
    })
  root.parse(["show", "Work", "--output", "copy.txt"], { from: "user" })
  absolutePaths(seen as Command, "/client")

  expect(seen?.processedArgs).toEqual(["Work"])
  expect(seen?.opts()).toEqual({ output: "/client/copy.txt" })
})

describe("the program applies it to MCP calls only", () => {
  const call = async (argv: string[], agent: boolean) => {
    const { env } = sandbox()
    const streams = captureStreams()
    let failure: ErrorObject | undefined
    await run(argv, sharedProgram, {
      streams,
      tty: false,
      env: { ...env, CHAT_PROFILE: "default" },
      ...(agent ? { agent: { result: () => {}, failure: (one) => (failure = one) } } : {}),
    })
    return { failure, stderr: streams.stderr.join("") }
  }

  it("an agent's store backup into a credential folder is refused before it runs; the owner's is not", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "path-options-home-")), ".ssh", "copy.db")

    const agent = await call(["store", "backup", target], true)
    expect(agent.failure?.error).toMatchObject({ code: "permission_error", param: "<file>" })
    expect(agent.failure?.error.message).toMatch(/^<file> .*credential folder/)

    const owner = await call(["store", "backup", target], false)
    expect(owner.stderr).not.toMatch(/credential folder/)
    expect(owner.stderr).toMatch(/no store at/)
  })
})

describe("every input named like a path is declared", () => {
  const refuse = async (): Promise<never> => {
    throw new Error("not run")
  }
  const trees = (): Command[] => {
    const disk = { command: "disk", appName: "disk-cli", envPrefix: "DISK", description: "x", version: "1.0.0" }
    const files = new Command("disk").command("files")
    addFileEditCommands(files, {
      words: { app: "disk", remote: "disk", provider: "Disk", source: "disk" },
      output: () => undefined,
      path: (input) => input,
      reread: (input) => input,
      stdin: () => undefined,
      read: refuse,
      write: refuse,
      restoreFromTrash: refuse,
    })
    const history = new Command("disk")
    addDocumentHistoryCommands(history, {
      words: { app: "disk", remote: "disk", provider: "Disk", source: "disk" },
      output: () => undefined,
      run: refuse,
      id: (input) => input,
    })
    const tracker = new Command("tracker")
    addTrackerCommands(tracker, { app: disk, open: refuse, writes: TRACKER_WRITES })
    const never = (): never => {
      throw new Error("not run")
    }
    return [
      createProgram(sharedProgram),
      files,
      history,
      tracker,
      fileMirrorsCommand({
        identity: disk,
        service: "Disk",
        remote: "disk",
        root: { place: "Disk folder", description: "the Disk folder", examples: ["/Notes ./notes", "/ ~/Disk"] },
        output: never,
        profile: never,
        stateDir: never,
        keepForDays: never,
        connect: never,
        writeGuard: never,
        keysOf: never,
      }),
      fileConflictsCommand({
        identity: disk,
        remote: "disk",
        output: never,
        mirrors: never,
        pathOf: never,
        stateOf: never,
        versionsOf: never,
        connect: never,
      }),
    ]
  }
  const all = (command: Command): Command[] => [command, ...command.commands.flatMap(all)]

  it("as a local path, which MCP calls check, or as not local", () => {
    const undeclared = trees()
      .flatMap(all)
      .flatMap((command) => [
        ...command.options
          .filter((option) => (option.required || option.optional) && looksLikePath(option.name()))
          .filter((option) => !isLocalPathOption(command, option) && !isNotLocalPath(command, option.attributeName()))
          .map((option) => `${command.name()} ${option.flags}`),
        ...command.registeredArguments
          .filter((argument) => looksLikePath(argument.name()))
          .filter((argument) => !isLocalPathArgument(command, argument) && !isNotLocalPath(command, argument.name()))
          .map((argument) => `${command.name()} <${argument.name()}>`),
      ])

    expect(undeclared).toEqual([])
  })

  it("the remote paths of the files commands are not taken for local ones", () => {
    const remote = trees()
      .flatMap(all)
      .filter((command) => ["sheets", "documents"].includes(command.parent?.name() ?? ""))
      .flatMap((command) => command.registeredArguments.filter((argument) => isLocalPathArgument(command, argument)))

    expect(remote).toEqual([])
  })
})
