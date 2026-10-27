import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { CapturedTool, MatrixRow } from "../../src/parity/deep.js"

export const sandboxEnvironment = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: join(home, "home"),
  USERPROFILE: join(home, "home"),
  TEMP: home,
  TMP: home,
  APPDATA: join(home, "appdata"),
  LOCALAPPDATA: join(home, "local-appdata"),
  TMPDIR: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"),
  MESSAGING_STORE: join(home, "messages.db"),
  MAX_CONFIG_DIR: join(home, "max-config"),
  MAX_STATE_DIR: join(home, "max-state"),
  MAX_CACHE_DIR: join(home, "max-cache"),
  TG_CONFIG_DIR: join(home, "tg-config"),
  TG_STATE_DIR: join(home, "tg-state"),
  TG_CACHE_DIR: join(home, "tg-cache"),
  WIRECAT_STATE_DIR: join(home, "common"),
  MAX_NO_UPDATE_CHECK: "1",
  TG_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
})

export interface CaptureMode {
  mode: string
  argv: string[]
  config?: unknown
}

const AUDIT_PROFILE = "audit"
const profile = (permissions: Record<string, string> = {}) => ({ profiles: { [AUDIT_PROFILE]: { permissions } } })

/**
 * The profiles an MCP server is captured under: its permissions, not its flags, decide what an agent is offered.
 * Each names a configured profile, since a server started without one stops.
 */
export const captureModes = (resources: readonly string[]): CaptureMode[] => [
  { mode: "default", argv: [AUDIT_PROFILE, "mcp", "serve"], config: profile() },
  {
    mode: "read-only",
    argv: [AUDIT_PROFILE, "mcp", "serve"],
    config: profile(Object.fromEntries(resources.filter((one) => one !== "bot").map((one) => [one, "readonly"]))),
  },
  { mode: "deny-send", argv: [AUDIT_PROFILE, "mcp", "serve"], config: profile({ "messages.send": "deny" }) },
]

export const CAPTURE_MODES = captureModes([]).map(({ mode }) => mode)

// Nested caller TMPDIR values can exceed the consumer's Unix socket path limit.
export const temporaryHome = () => mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pa-"))
export const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T
export const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export interface Check {
  name: string
  argv: string[]
  exit: number | null
  signal?: string
  error?: string
  milliseconds: number
  log: string
}
export const check = async (
  root: string,
  name: string,
  argv: string[],
  output: string,
  env: NodeJS.ProcessEnv,
): Promise<Check> => {
  console.error(`deep audit: ${name} (${root})`)
  const start = Date.now()
  let data = ""
  let failure: string | undefined
  const [bin, ...args] = argv
  if (!bin) throw new Error("empty check argv")
  const child = spawn(bin, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  const append = (chunk: Buffer) => {
    data += chunk.toString()
  }
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  child.on("error", (error) => {
    failure = error.message
  })
  const timer = setTimeout(() => {
    failure = "check exceeded 10 minutes"
    child.kill()
  }, 600_000)
  const result = await new Promise<{ exit: number | null; signal: string | null }>((resolve) =>
    child.once("close", (exit, signal) => resolve({ exit, signal })),
  )
  clearTimeout(timer)
  writeFileSync(output, data)
  return {
    name,
    argv,
    exit: result.exit,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(failure ? { error: failure } : {}),
    milliseconds: Date.now() - start,
    log: output,
  }
}

interface Described {
  command: string
  description: string
  writes: boolean
  arguments: unknown
}

export const mcpSchemas = async (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number } = {},
): Promise<CapturedTool[]> => {
  const child = spawn("node", [bin, ...args], { env, stdio: ["pipe", "pipe", "pipe"] })
  let buffer = ""
  let stderr = ""
  let completed = false
  // A server of three tools is expanded into its commands, so two CLIs compare command by command.
  let search: string | undefined
  let commands: string[] = []
  const expanded = new Map<string, CapturedTool>()
  const answer = (message: { result?: { content?: { text: string }[] } }): unknown =>
    JSON.parse(message.result?.content?.[0]?.text ?? "null")
  const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`)
  const result = new Promise<CapturedTool[]>((resolve, reject) => {
    const fail = (error: Error) => {
      if (!completed) {
        completed = true
        reject(error)
      }
    }
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2048)
    })
    child.on("close", (code) => fail(new Error(`MCP closed (${code}) before tools/list: ${stderr}`)))
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 8_388_608) return fail(new Error("MCP frame exceeded 8 MiB"))
      let at = buffer.indexOf("\n")
      while (at >= 0 && !completed) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line) {
          try {
            const message = JSON.parse(line) as {
              id?: number
              error?: unknown
              result?: { tools?: CapturedTool[]; content?: { text: string }[] }
            }
            if (message.error) return fail(new Error(`MCP error: ${JSON.stringify(message.error)}`))
            if (message.id === 1) {
              send({ jsonrpc: "2.0", method: "notifications/initialized" })
              send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
            } else if (message.id === 2) {
              if (!Array.isArray(message.result?.tools)) return fail(new Error("MCP returned no tools array"))
              search = message.result.tools.find((tool) => tool.name.endsWith("_tools_search"))?.name
              if (!search) {
                completed = true
                resolve(message.result.tools)
              } else send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: search, arguments: {} } })
            } else if (message.id === 3) {
              commands = (answer(message) as { items: { command: string }[] }).items.map(({ command }) => command)
              if (commands.length === 0) {
                completed = true
                resolve([])
              }
              for (const [at, query] of commands.entries())
                send({
                  jsonrpc: "2.0",
                  id: 4 + at,
                  method: "tools/call",
                  params: { name: search, arguments: { query } },
                })
            } else if (message.id !== undefined && message.id >= 4) {
              const command = commands[message.id - 4] as string
              const found = (answer(message) as { items: Described[] }).items.find((one) => one.command === command)
              if (!found) return fail(new Error(`${search} did not describe ${command}`))
              expanded.set(command, {
                name: `${String(search).replace(/_tools_search$/, "")}_${command.replaceAll(/[ -]/g, "_")}`,
                description: found.description,
                inputSchema: found.arguments,
                annotations: { readOnlyHint: !found.writes },
              })
              if (expanded.size === commands.length) {
                completed = true
                resolve(commands.map((one) => expanded.get(one) as CapturedTool))
              }
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        }
        at = buffer.indexOf("\n")
      }
    })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "parity-audit", version: "0" },
      },
    })
    const timer = setTimeout(() => fail(new Error("MCP tools/list timed out")), options.timeoutMs ?? 30_000)
    void resultCleanup()
    async function resultCleanup() {
      await new Promise<void>((resolve) => child.once("close", () => resolve()))
      clearTimeout(timer)
    }
  })
  try {
    return await result
  } finally {
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once("close", () => resolve())
    })
    child.kill()
    const hard = setTimeout(() => child.kill("SIGKILL"), 2000)
    await closed
    clearTimeout(hard)
  }
}

export interface SourceLine {
  file: string
  line: number
  kind: string
  text: string
}
export const sourceEvidence = (root: string): SourceLine[] => {
  const output: SourceLine[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".ts") && !/\.test\.ts$|generated/.test(path)) {
        const file = relative(root, path).replaceAll("\\", "/")
        const lines = readFileSync(path, "utf8").split("\n")
        for (const [at, text] of lines.entries()) {
          const kinds = [
            ...(/(?:from|import)\s*["']/.test(text) ? ["import"] : []),
            ...(/export (?:const|class|function|interface)/.test(text) ? ["definition"] : []),
            ...(/\.(?:command|addCommand|registerTool)\(/.test(text) ? ["registration"] : []),
            ...(/services\.\w+\./.test(text) ? ["service-call"] : []),
          ]
          for (const kind of kinds) output.push({ file, line: at + 1, kind, text: text.trim() })
        }
      }
    }
  }
  walk(join(root, "src"))
  return output.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

export interface Assertion {
  fullName: string
  status: string
}
export interface Suite {
  name: string
  assertionResults: Assertion[]
}
export interface TestResults {
  testResults: Suite[]
  numPassedTests: number
  numFailedTests: number
  numPendingTests: number
}
export interface CoverageMetric {
  total: number
  covered: number
  pct: number
}
export type Coverage = Record<
  string,
  { lines: CoverageMetric; branches: CoverageMetric; functions: CoverageMetric; statements: CoverageMetric }
>
export interface TestEvidence {
  state: "ran" | "not-run" | "failed"
  checks: Check[]
  results?: TestResults
  coverage?: Coverage
  matrix: MatrixRow[]
  exclusions: string[]
}

export interface MountEvidence {
  group: string
  binding?: { symbol: string; module: string; line: number }
  file?: string
  sharedReferences: SourceLine[]
  localRegistrations: SourceLine[]
  verdict: string
}
export const mountingEvidence = (root: string, groups: string[], sources: SourceLine[]): MountEvidence[] => {
  const path = join(root, "src/program.ts")
  if (!existsSync(path))
    return groups.map((group) => ({
      group,
      sharedReferences: [],
      localRegistrations: [],
      verdict: "program source missing",
    }))
  const text = readFileSync(path, "utf8")
  const imports = new Map<string, { symbol: string; module: string; line: number }>()
  for (const match of text.matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)) {
    const module = match[2] ?? ""
    const line = text.slice(0, match.index).split("\n").length
    for (const item of (match[1] ?? "").replace(/[{}]/g, "").split(",")) {
      const parsed = item.trim().match(/^(?!type\b)(\w+)(?:\s+as\s+(\w+))?$/)
      if (parsed) imports.set(parsed[2] ?? parsed[1] ?? "", { symbol: parsed[1] ?? "", module, line })
    }
  }
  return groups.map((group) => {
    const candidate = `${group.replace(/-([a-z])/g, (_all, one: string) => one.toUpperCase())}Command`
    const binding = imports.get(candidate)
    const file = binding?.module.startsWith(".")
      ? relative(root, join(root, "src", binding.module.replace(/\.js$/, ".ts"))).replaceAll("\\", "/")
      : undefined
    const entries = sources.filter((one) => one.file === file)
    const sharedReferences = entries.filter(
      (one) => one.kind === "import" && /@wirecat\/(?:cli-core|cli-base)/.test(one.text),
    )
    const localRegistrations = entries.filter((one) => one.kind === "registration")
    return {
      group,
      ...(binding ? { binding } : {}),
      ...(file ? { file } : {}),
      sharedReferences,
      localRegistrations,
      verdict: !binding
        ? "unresolved dynamic/aliased mount: inspect program source"
        : file
          ? "local mounting file; shared references and local registrations below are candidates, not use-case equivalence"
          : "direct imported factory; descriptor/overrides/adapter semantics still require review",
    }
  })
}

export const testSummary = (results: TestResults): TestResults => ({
  numPassedTests: results.numPassedTests,
  numFailedTests: results.numFailedTests,
  numPendingTests: results.numPendingTests,
  testResults: results.testResults.map((suite) => ({
    name: suite.name,
    assertionResults: suite.assertionResults.map((test) => ({ fullName: test.fullName, status: test.status })),
  })),
})
