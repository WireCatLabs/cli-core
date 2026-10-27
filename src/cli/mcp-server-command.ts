import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { alive, carries } from "../background/processes.js"
import { type ServerSystem, thisMachine } from "../background/system.js"
import { readableLog, tail } from "../background/units.js"
import { mcpUrlOf, portOf, publicUrlOf } from "../http/public-url.js"
import {
  type HttpLock,
  httpLockFile,
  httpLogFile,
  mcpHttpMarker,
  readHttpLock,
  signedInClients,
} from "../mcp/http/state.js"
import { destroysNothing, LOCAL_READ, LOCAL_WRITE } from "./effects.js"

export const MCP_HTTP_DEFAULT_PORT = 8765
const LOOKS = 120

/** What one CLI tells `mcp server` about the server it would run. */
export interface McpServerTarget {
  /** What a person types before `mcp`: `tg personal`, `memo`. */
  invocation: string
  /** Absent for a CLI without profiles. */
  profile?: string
  envPrefix: string
  env: NodeJS.ProcessEnv
  tokenFile: string
  /** The words after the CLI's own entry that run `mcp --http` in the foreground, before `--port`. */
  argv: string[]
  /** Added to the server's environment: the profile, for a CLI that reads it from there. */
  childEnv?: Record<string, string>
  version: string
}

export interface McpServerOptions {
  /** How help shows the CLI before `mcp`: `tg personal`. */
  example: string
  /** The CLI's own `mcp --http` default, when it is not 8765. */
  defaultPort?: number
  target: (self: Command) => McpServerTarget
  /** The CLI's own answer: the item in `--json`, else the lines. */
  answer: (self: Command, item: object, lines: string[]) => void
  system?: (self: Command) => ServerSystem | undefined
}

const clock = (iso: string) => {
  const when = new Date(iso)
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return when.toDateString() === new Date().toDateString() ? time : `${when.toLocaleDateString("sv-SE")} ${time}`
}

const connectorUrl = (lock: HttpLock) => mcpUrlOf(new URL(lock.publicUrl)).href

const liveCode = (lock: HttpLock, now: number) =>
  lock.loginCode && lock.loginCodeExpiresAt && Date.parse(lock.loginCodeExpiresAt) > now
    ? { code: lock.loginCode, expires_at: lock.loginCodeExpiresAt }
    : null

const markerOf = (target: McpServerTarget) => `${mcpHttpMarker(target.envPrefix)}=${target.profile ?? "default"}`

/** Who started it decides whether `stop` may end it: only a process that carries our marker. */
const byOf = (target: McpServerTarget, pid: number) => (carries(pid, markerOf(target)) ? "server" : "hand")

const serving = (target: McpServerTarget, lock: HttpLock, now: number) => ({
  pid: lock.pid,
  started_at: lock.startedAt,
  listening: lock.listeningAt !== undefined,
  by: byOf(target, lock.pid),
  port: lock.port,
  public_url: lock.publicUrl,
  connector_url: connectorUrl(lock),
  login_code: liveCode(lock, now),
  ...(lock.version ? { version: lock.version, outdated: lock.version !== target.version } : {}),
})

const clientLines = (clients: ReturnType<typeof signedInClients>) =>
  clients.length === 0
    ? ["No browser app is logged in."]
    : [
        `Logged-in apps (names are what each app calls itself): ${clients
          .map(
            (one) =>
              `${one.claimedName === null ? "no name" : JSON.stringify(one.claimedName)} (${clock(one.lastLoginAt)})`,
          )
          .join(", ")}.`,
      ]

/**
 * `mcp --http` in the background: `start`, `stop`, `status`, as `server` does for `serve`. The server
 * keeps a lock beside its token file (`state.ts`) with its port, address and login code, so status
 * survives the shell that started it, and `stop` ends only a process that carries this CLI's marker.
 * None of it is offered over MCP: status holds a live login code.
 */
export const mcpServerCommand = ({
  example,
  defaultPort = MCP_HTTP_DEFAULT_PORT,
  target,
  answer,
  system,
}: McpServerOptions): Command => {
  const command = annotate(new Command("server"), { effects: LOCAL_READ, mcp: false })
    .summary("run the HTTP MCP server in the background")
    .description("start, stop and check `mcp --http` in the background; status shows the login code for a browser app")
  const machine = (self: Command) => system?.(self) ?? thisMachine()

  destroysNothing(
    annotate(command.command("start"), {
      effects: LOCAL_WRITE,
      mcp: false,
      examples: [`${example} mcp server start --public-url https://laptop.example.ts.net`],
    }),
  )
    .summary("start the HTTP MCP server in the background")
    .description("start `mcp --http` apart from this shell and answer once it listens, with its login code")
    .option("--port <port>", `the local port (default ${defaultPort})`)
    .option(
      "--public-url <url>",
      "the tunnel's https address the browser apps use, e.g. https://<name>.ts.net or https://<name>.ts.net/tg",
    )
    .option(
      "--permission <key=level>",
      "make a permission stricter for this server only; repeat for more keys",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async function (this: Command) {
      // A CLI whose `mcp` takes the same flags reads them first, so they are looked up on both.
      const flags = this.optsWithGlobals<{ port?: string; publicUrl?: string; permission?: string[] }>()
      const one = target(this)
      const url = publicUrlOf(flags.publicUrl, {
        missing: "mcp server start",
        reaches: "the browser apps reach it",
        path: true,
      })
      const port = portOf(flags.port, defaultPort)
      const lockFile = httpLockFile(one.tokenFile)
      const before = readHttpLock(lockFile)
      if (before && alive(before.pid)) {
        answer(
          this,
          { profile: one.profile ?? null, started: false, running: true, ...serving(one, before, Date.now()) },
          [
            `Already serving ${one.invocation} over HTTP since ${clock(before.startedAt)} (PID ${before.pid}, port ${before.port}).`,
          ],
        )
        return
      }
      const sys = machine(this)
      const log = httpLogFile(one.tokenFile)
      const { [`${one.envPrefix}_TIMEOUT`]: _timeout, ...inherited } = one.env
      const pid = sys.spawn(
        [
          ...one.argv,
          "--port",
          String(port),
          "--public-url",
          url.pathname === "/" ? url.origin : url.href,
          ...(flags.permission ?? []).flatMap((entry) => ["--permission", entry]),
        ],
        { ...inherited, ...one.childEnv, [mcpHttpMarker(one.envPrefix)]: one.profile ?? "default" },
        log,
      )
      for (let look = 0; look < LOOKS; look++) {
        const now = readHttpLock(lockFile)
        if (now?.pid === pid && now.listeningAt) {
          const code = liveCode(now, Date.now())
          answer(
            this,
            { profile: one.profile ?? null, started: true, running: true, ...serving(one, now, Date.now()), log },
            [
              `Started: serving ${one.invocation} over HTTP (PID ${pid}) on 127.0.0.1:${now.port}.`,
              `Browser apps connect to ${connectorUrl(now)}`,
              ...(code ? [`Login code for a new browser app: ${code.code} (until ${clock(code.expires_at)}).`] : []),
            ],
          )
          return
        }
        if (!alive(pid)) {
          const last = readableLog(tail(log, 5)).trim()
          throw new CliError("provider_unavailable", `mcp --http stopped before it listened${last ? `:\n${last}` : ""}`)
        }
        await sys.pause()
      }
      throw new CliError(
        "timeout",
        `mcp --http is running but not listening yet — \`${one.invocation} mcp server status\`; its log: ${log}`,
      )
    })

  destroysNothing(
    annotate(command.command("stop"), { effects: LOCAL_WRITE, mcp: false, examples: [`${example} mcp server stop`] }),
  )
    .summary("stop the background HTTP MCP server")
    .description("stop `mcp --http` — only one that `mcp server start` started")
    .action(async function (this: Command) {
      const one = target(this)
      const lock = readHttpLock(httpLockFile(one.tokenFile))
      if (!lock || !alive(lock.pid)) {
        answer(this, { profile: one.profile ?? null, stopped: false }, [
          `Nothing to stop: ${one.invocation} is not serving MCP over HTTP.`,
        ])
        return
      }
      if (byOf(one, lock.pid) !== "server") {
        throw new CliError(
          "validation_error",
          `mcp --http for ${one.invocation} (PID ${lock.pid}) was not started by \`${one.invocation} mcp server start\` — stop it where it runs`,
        )
      }
      process.kill(lock.pid, "SIGTERM")
      const sys = machine(this)
      for (let look = 0; look < LOOKS && alive(lock.pid); look++) await sys.pause()
      if (alive(lock.pid)) throw new CliError("timeout", `mcp --http (PID ${lock.pid}) has not stopped yet`)
      answer(this, { profile: one.profile ?? null, stopped: true, pid: lock.pid }, [
        `Stopped serving ${one.invocation} over HTTP (PID ${lock.pid}).`,
      ])
    })

  annotate(command.command("status"), {
    effects: LOCAL_READ,
    mcp: false,
    examples: [`${example} mcp server status --json`],
  })
    .summary("whether the HTTP MCP server runs, its login code and the apps logged in")
    .description(
      "whether `mcp --http` runs, on which port and address, the login code for a new browser app, and the apps logged in",
    )
    .action(function (this: Command) {
      const one = target(this)
      const lock = readHttpLock(httpLockFile(one.tokenFile))
      const now = Date.now()
      const running = lock !== undefined && alive(lock.pid)
      const clients = signedInClients(one.tokenFile, now)
      const live = running ? serving(one, lock, now) : undefined
      answer(
        this,
        {
          profile: one.profile ?? null,
          running,
          ...(live ?? {}),
          ...(lock && !running ? { stale: { pid: lock.pid, started_at: lock.startedAt } } : {}),
          clients: clients.map((client) => ({
            claimed_name: client.claimedName,
            last_login_at: client.lastLoginAt,
          })),
          log: httpLogFile(one.tokenFile),
        },
        [
          live && lock
            ? `Serving ${one.invocation} over HTTP since ${clock(lock.startedAt)} (PID ${lock.pid}) on port ${lock.port}${live.listening ? "" : ", not listening yet"}; browser apps connect to ${live.connector_url}. ${live.by === "server" ? `Started by \`${one.invocation} mcp server start\`.` : "Started by hand — `mcp server stop` leaves it alone."}`
            : `Not serving ${one.invocation} over HTTP.`,
          ...(live?.login_code
            ? [
                `Login code for a new browser app: ${live.login_code.code} (until ${clock(live.login_code.expires_at)}).`,
              ]
            : []),
          ...(lock && !running
            ? [
                `A server that started ${clock(lock.startedAt)} (PID ${lock.pid}) is gone; the next start takes its place.`,
              ]
            : []),
          ...clientLines(clients),
        ],
      )
    })

  return command
}
