import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { build } from "esbuild"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { type CommandAnswer, inCommandServerRequest, refuseInCommandServer, serveCommands } from "./command-server.js"
import { readsStdin } from "./stdin-field.js"

const serving = (run: (argv: string[]) => Promise<CommandAnswer>, idleMs?: number) => {
  const input = new PassThrough()
  const lines: Record<string, unknown>[] = []
  const done = serveCommands({
    input,
    write: async (line) => {
      lines.push(JSON.parse(line))
    },
    run,
    cli: "chat",
    version: "1.2.3",
    ...(idleMs === undefined ? {} : { idleMs }),
  })
  return { input, lines, done }
}

const echo = async (argv: string[]): Promise<CommandAnswer> => ({ code: 0, stdout: `${argv.join(" ")}\n`, stderr: "" })

describe("serveCommands", () => {
  it("**says it is ready, then answers each request in order, one at a time**, and ends with 0 when stdin closes", async () => {
    let running = 0
    let most = 0
    const { input, lines, done } = serving(async (argv) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, argv[0] === "slow" ? 5 : 0))
      running -= 1
      return echo(argv)
    })
    input.write('{"id":1,"argv":["slow"]}\n{"id":2,"argv":["fast","--json"]}\n')
    input.end()

    expect(await done).toBe(0)
    expect(lines).toEqual([
      { ready: true, protocol: 1, version: "1.2.3" },
      { id: 1, code: 0, stdout: "slow\n", stderr: "" },
      { id: 2, code: 0, stdout: "fast --json\n", stderr: "" },
    ])
    expect(most).toBe(1)
  })

  it("answers a line it cannot read with code 2 and keeps going", async () => {
    const { input, lines, done } = serving(echo)
    input.end(
      'not json\n{"argv":["x"]}\n{"id":3,"argv":"chats list"}\n{"id":4,"argv":["commands","--serve"]}\n{"id":5,"argv":["ok"]}\n',
    )
    await done

    const answers = lines.slice(1) as { id: number | null; code: number; stdout: string; stderr: string }[]
    expect(answers.map(({ id, code }) => [id, code])).toEqual([
      [null, 2],
      [null, 2],
      [3, 2],
      [4, 2],
      [5, 0],
    ])
    expect(JSON.parse(answers[0]?.stderr ?? "")).toMatchObject({ error: { code: "validation_error" } })
    expect(answers[3]?.stderr).toContain("cannot run inside itself")
  })

  it("**ends on its own after the idle time**, never while a request is still running", async () => {
    const { input, lines, done } = serving(async (argv) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return echo(argv)
    }, 10)
    input.write('{"id":1,"argv":["long"]}\n')

    expect(await done).toBe(0)
    expect(lines.at(-1)).toEqual({ id: 1, code: 0, stdout: "long\n", stderr: "" })
  })
})

describe("refuseInCommandServer", () => {
  const program = new Command("chat")
  const serve = annotate(program.command("serve"), { lifetime: "persistent" })
  const login = annotate(program.command("login"), { lifetime: "interactive" })
  const add = readsStdin(program.command("add"), { name: "text", description: "the text" })
  const list = program.command("list")

  it("lets everything through outside a request", () => {
    expect(() => refuseInCommandServer(serve, "chat")).not.toThrow()
  })

  it("refuses inside a request what never returns, waits on a person or reads stdin", () => {
    inCommandServerRequest(() => {
      expect(() => refuseInCommandServer(serve, "chat")).toThrow("`chat serve` runs until it is stopped")
      expect(() => refuseInCommandServer(login, "chat")).toThrow("waits on a person")
      expect(() => refuseInCommandServer(add, "chat")).toThrow("reads its input on stdin")
      expect(() => refuseInCommandServer(list, "chat")).not.toThrow()
    })
  })
})

describe("chat commands --serve, as a process", () => {
  let cli = ""
  const root = mkdtempSync(join(tmpdir(), "command-server-"))
  const store = join(root, "store.db")
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    MESSAGING_STORE: store,
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CACHE_DIR: join(root, "cache"),
    CHAT_PROFILE: "",
    // A throwaway HOME does not hide the keyring; D-Bus reaches it.
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
    WIRECAT_CALLER: "desktop",
  }

  beforeAll(async () => {
    const out = join(root, "cli")
    await build({
      entryPoints: ["command-server-cli.ts", "command-server-own-program.ts"].map((name) =>
        fileURLToPath(new URL(`../testing/${name}`, import.meta.url)),
      ),
      outdir: out,
      bundle: true,
      // The store's drivers are imported only on the runtime that has them.
      splitting: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      plugins: [
        {
          name: "packages-in-place",
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, ({ path }) =>
              /^(node|bun):/.test(path) ? { external: true } : { path: import.meta.resolve(path), external: true },
            )
          },
        },
      ],
    })
    cli = join(out, "command-server-cli.js")
  }, 60_000)

  const spawned = async (argv: string[]): Promise<CommandAnswer> => {
    const child = spawn(process.execPath, [cli, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const [code] = await once(child, "close")
    return { code, stdout, stderr }
  }

  const servers: ChildProcess[] = []
  afterEach(() => {
    for (const child of servers.splice(0)) child.stdin?.end()
  })

  const server = async (bin = cli) => {
    const child = spawn(process.execPath, [bin, "commands", "--serve"], { env, stdio: ["pipe", "pipe", "pipe"] })
    servers.push(child)
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const next = async () => JSON.parse((await lines.next()).value as string)
    let id = 0
    const ask = async (argv: string[]): Promise<CommandAnswer & { id: number }> => {
      id += 1
      child.stdin.write(`${JSON.stringify({ id, argv })}\n`)
      return next()
    }
    return { child, ready: await next(), ask }
  }

  const steady = (text: string) =>
    text.replace(/"run_id":"[^"]+"/g, '"run_id":"…"').replace(/"duration_ms":\d+/g, '"duration_ms":0')

  it("**answers as a spawned run prints**, and ends with 0 when stdin closes", async () => {
    const { child, ready, ask } = await server()
    expect(ready).toEqual({ ready: true, protocol: 1, version: "1.0.0" })
    for (const argv of [
      ["work", "config", "show", "--json"],
      ["work", "store", "info", "--json"],
      ["nobody", "chats", "list", "--offline", "--json"],
      ["work", "commands", "store"],
    ]) {
      const { id: _, ...answer } = await ask(argv)
      const alone = await spawned(argv)
      expect({ ...answer, stdout: steady(answer.stdout) }, argv.join(" ")).toEqual({
        ...alone,
        stdout: steady(alone.stdout),
      })
    }
    child.stdin?.end()
    const [code] = await once(child, "close")
    expect(code).toBe(0)
  }, 60_000)

  it.runIf(process.platform === "linux")(
    "**holds no descriptor of the store** once a request is answered",
    async () => {
      const { child, ask } = await server()
      expect((await ask(["work", "store", "info", "--json"])).code).toBe(0)
      expect((await ask(["work", "chats", "list", "--offline", "--json"])).stderr).not.toContain("internal")

      const fds = join("/proc", String(child.pid), "fd")
      const open = readdirSync(fds).flatMap((fd) => {
        try {
          return [readlinkSync(join(fds, fd))]
        } catch {
          return []
        }
      })
      expect(open.filter((target) => target.startsWith(store))).toEqual([])
    },
    30_000,
  )

  it("**reads the settings again on each request**: a change made between two is seen by the second", async () => {
    const { ask } = await server()
    const limit = async () =>
      JSON.parse((await ask(["work", "config", "show", "--json"])).stdout).item.settings.find(
        (one: { setting: string }) => one.setting === "limit",
      ).value
    const before = await limit()
    expect((await spawned(["work", "config", "set", "limit", String(before + 1)])).code).toBe(0)

    expect(await limit()).toBe(before + 1)
  }, 30_000)

  it("**keeps each request as a run of its own**, from the caller the server was started by", async () => {
    const { ask } = await server()
    const ids = [] as string[]
    for (let time = 0; time < 2; time++)
      ids.push(JSON.parse((await ask(["work", "store", "info", "--json"])).stdout).meta.run_id)
    expect(new Set(ids).size).toBe(2)

    // A failed run is kept as a spawned one is; a successful read is not.
    const days = join(root, "state", "runs")
    const failed = () =>
      readdirSync(days)
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
        .flatMap((day) =>
          readdirSync(join(days, day))
            .filter((name) => name.includes("chats-list"))
            .map((name) => JSON.parse(readFileSync(join(days, day, name, "run.json"), "utf8"))),
        )
    const before = new Set(failed().map((record) => record.run_id))
    for (let time = 0; time < 2; time++)
      expect((await ask(["work", "chats", "list", "--offline", "--json"])).code).toBe(6)
    const records = failed().filter((record) => !before.has(record.run_id))
    expect(records).toHaveLength(2)
    for (const record of records) expect(record).toMatchObject({ command: "chats list", via: "desktop" })
  }, 30_000)

  it("**refuses with code 2** a command that never returns, and keeps serving", async () => {
    const { ask } = await server()
    for (const argv of [
      ["work", "serve"],
      ["work", "watch"],
    ]) {
      const answer = await ask(argv)
      expect(answer.code, argv.join(" ")).toBe(2)
      expect(answer.stdout).toBe("")
      expect(JSON.parse(answer.stderr).error.message).toContain("runs until it is stopped")
    }
    expect((await ask(["work", "config", "show", "--json"])).code).toBe(0)
  }, 30_000)

  it("**adds nothing per request**: the twentieth answer is still what a spawned run prints, with no warning", async () => {
    const { ask } = await server()
    const argv = ["work", "config", "show", "--json"]
    const answers = []
    for (let time = 0; time < 20; time++) answers.push(await ask(argv))
    for (const answer of answers) expect(answer.stderr).not.toContain("MaxListeners")
    const { id: _, ...last } = answers.at(-1) as CommandAnswer & { id: number }
    const alone = await spawned(argv)
    expect({ ...last, stdout: steady(last.stdout) }).toEqual({ ...alone, stdout: steady(alone.stdout) })
  }, 30_000)

  it("ends with 0 on SIGTERM while stdin is still open", async () => {
    const { child } = await server()
    child.kill("SIGTERM")
    const [code] = await once(child, "close")
    expect(code).toBe(0)
  }, 30_000)

  it("**serves a CLI with its own program**: refuses through atStart, and a request's exit code is its own", async () => {
    const { ask } = await server(join(cli, "..", "command-server-own-program.js"))
    expect(await ask(["serve"])).toMatchObject({ code: 2, stdout: "" })
    expect(await ask(["partial"])).toMatchObject({ code: 6, stdout: "half\n", stderr: "" })
    expect(await ask(["ok"])).toMatchObject({ code: 0, stdout: "fine\n", stderr: "" })
    const broken = await ask(["broken"])
    expect(broken).toMatchObject({ code: 15, stdout: "" })
    expect(JSON.parse(broken.stderr).error).toMatchObject({ code: "conflict", message: "it broke" })
  }, 30_000)
})
