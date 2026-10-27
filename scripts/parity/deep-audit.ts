import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import {
  type CapturedTool,
  commandMap,
  comparePrograms,
  compareTools,
  matrixRows,
  valueDifferences,
} from "../../dist/parity/deep.js"
import type { CommandsJson, Manifest } from "../../dist/parity/manifest.js"
import { RESOURCES } from "../../dist/sends/permissions.js"
import {
  CAPTURE_MODES,
  type CaptureMode,
  type Coverage,
  captureModes,
  check,
  git,
  type MountEvidence,
  mcpSchemas,
  mountingEvidence,
  readJson,
  type SourceLine,
  sandboxEnvironment,
  sourceEvidence,
  type TestEvidence,
  type TestResults,
  temporaryHome,
  testSummary,
  writeJson,
} from "./evidence.ts"
import { renderReports } from "./report.ts"

export interface ToolCapture extends CaptureMode {
  tools?: CapturedTool[]
  error?: string
}
export interface FixtureResult {
  cli: string
  runtime?: string
  temp?: string
  checks?: { name: string; pass: boolean }[]
  results: { query: string; code: number; ids?: string[]; reason?: string; metadataKeys?: string[] }[]
  reads: { argv: string[]; code: number; answer: unknown }[]
  networkAttempts: number
}
export interface Snapshot {
  commit: string
  version: string
  pins: Record<string, string>
  dirty: string
  repository?: string
}
export interface DeepSide {
  root: string
  snapshot: Snapshot
  program: CommandsJson
  mcp: ToolCapture[]
  sources: SourceLine[]
  mounts: MountEvidence[]
  tests: TestEvidence
  fixture?: FixtureResult
  bunFixture?: FixtureResult
  fixtureError?: string
  searchProfile?: unknown
  searchProfileError?: string
  movedTo?: string
  remoteError?: string
}
export interface DeepBundle {
  schema: 1
  capturedAt: string
  manifest: Manifest
  shared: { root: string; snapshot: Snapshot; sources: SourceLine[]; tests: TestEvidence }
  sides: Record<string, DeepSide>
  comparison: ReturnType<typeof comparePrograms>
  tools: Record<string, ReturnType<typeof compareTools>>
  fixtureDifferences: string[]
  searchProfileDifferences: ReturnType<typeof valueDifferences>
  retainedPaths: string[]
  complete: boolean
}

interface Package {
  version: string
  scripts: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const snapshot = (root: string): Snapshot => {
  const pkg = readJson<Package>(join(root, "package.json"))
  const remote = git(root, "remote", "get-url", "origin").match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return {
    ...(remote ? { repository: `https://github.com/${remote[1]}/${remote[2]}` } : {}),
    commit: git(root, "rev-parse", "HEAD"),
    version: pkg.version,
    pins: Object.fromEntries(
      Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => name.startsWith("@wirecat/")),
    ),
    dirty: git(root, "status", "--porcelain"),
  }
}
const captureTools = async (
  root: string,
  cli: string,
  program: CommandsJson,
  retained: string[],
): Promise<ToolCapture[]> => {
  const bin = join(root, "dist/bin", `${cli}.js`)
  if (!commandMap(program).get("mcp serve"))
    return [{ mode: "default", argv: ["mcp", "serve"], error: "mcp serve command absent" }]
  const captures: ToolCapture[] = []
  for (const mode of captureModes(RESOURCES)) {
    const home = temporaryHome()
    retained.push(home)
    const env = sandboxEnvironment(home)
    if (mode.config)
      writeJson(join(env[`${cli.toUpperCase()}_CONFIG_DIR`] ?? join(home, "config"), "config.json"), mode.config)
    try {
      captures.push({ ...mode, tools: await mcpSchemas(bin, mode.argv, env) })
    } catch (error) {
      captures.push({ ...mode, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return captures
}

const testEvidence = async (
  root: string,
  cli: string,
  output: string,
  skip: boolean,
  retained: string[],
): Promise<TestEvidence> => {
  const pkg = readJson<Package>(join(root, "package.json"))
  const config = join(root, "vitest.config.ts")
  const exclusions = existsSync(config) ? readFileSync(config, "utf8").split("\n") : []
  if (skip) return { state: "not-run", checks: [], matrix: [], exclusions }
  const home = temporaryHome()
  retained.push(home)
  const env = sandboxEnvironment(home)
  const jsonPath = join(output, `${cli}-tests.json`)
  const checks = [
    await check(
      root,
      "coverage",
      [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--coverage",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${jsonPath}`,
      ],
      join(output, `${cli}-coverage.log`),
      env,
    ),
  ]
  for (const script of ["lint", "typecheck", "docs:check", "check:dist", "smoke:bun"]) {
    if (pkg.scripts[script])
      checks.push(
        await check(root, script, ["pnpm", script], join(output, `${cli}-${script.replaceAll(":", "-")}.log`), env),
      )
  }
  const matrix = join(root, "scripts/test-matrix-untested.ts")
  if (existsSync(matrix))
    checks.push(
      await check(
        root,
        "test:matrix",
        [
          "pnpm",
          "exec",
          "cli-dev",
          "test-matrix",
          "--program",
          "dist/program.js",
          "--untested",
          "scripts/test-matrix-untested.ts",
          "--name",
          cli,
          "--check",
        ],
        join(output, `${cli}-matrix.log`),
        env,
      ),
    )
  const coverage = join(root, "coverage/coverage-summary.json")
  const matrixPath = join(root, "docs/dev/test-matrix.md")
  const ran = checks[0]?.exit === 0
  const artifacts = existsSync(jsonPath) && existsSync(coverage)
  if (ran && !artifacts)
    checks.push({
      name: "coverage-artifacts",
      argv: [],
      exit: 1,
      milliseconds: 0,
      log: checks[0]?.log ?? "",
      error: "fresh test JSON or coverage summary missing",
    })
  return {
    state: checks.every((one) => one.exit === 0 && !one.error) ? "ran" : "failed",
    checks,
    ...(existsSync(jsonPath) ? { results: testSummary(readJson<TestResults>(jsonPath)) } : {}),
    ...(ran && existsSync(coverage) ? { coverage: readJson<Coverage>(coverage) } : {}),
    matrix:
      checks.find((one) => one.name === "test:matrix")?.exit === 0 && existsSync(matrixPath)
        ? matrixRows(readFileSync(matrixPath, "utf8"))
        : [],
    exclusions,
  }
}

const fixtureComparison = (left?: FixtureResult, right?: FixtureResult): string[] => {
  if (!left || !right) return ["consumer fixture missing or failed"]
  const differences: string[] = []
  if (JSON.stringify(left.results) !== JSON.stringify(right.results))
    differences.push("search ids/errors/metadata keys differ")
  if (left.networkAttempts || right.networkAttempts) differences.push("fixture attempted a connection")
  if (JSON.stringify(left.checks) !== JSON.stringify(right.checks)) differences.push("scenario checks differ")
  if ([...(left.checks ?? []), ...(right.checks ?? [])].some((one) => !one.pass))
    differences.push("scenario check failed")
  const normalize = (answer: unknown, argv: string[]): unknown => {
    if (argv.join(" ") !== "store check") return answer
    const data = JSON.parse(JSON.stringify(answer)) as {
      path?: string
      disk?: { free?: number }
      wordIndex?: { builtAt?: string }
    }
    delete data.path
    if (data.disk) delete data.disk.free
    if (data.wordIndex) delete data.wordIndex.builtAt
    return data
  }
  for (const [at, one] of left.reads.entries()) {
    const two = right.reads[at]
    if (
      !two ||
      JSON.stringify(one.argv) !== JSON.stringify(two.argv) ||
      one.code !== two.code ||
      JSON.stringify(normalize(one.answer, one.argv)) !== JSON.stringify(normalize(two.answer, two.argv))
    )
      differences.push(`read differs: ${one.argv.join(" ")}`)
  }
  if (left.reads.length !== right.reads.length) differences.push("read scenario counts differ")
  return differences
}

export const runDeepAudit = async (options: {
  root: string
  dirs: Record<string, string>
  manifest: Manifest
  output: string
  skipChecks?: boolean
  surface: string
  retainedPaths?: string[]
}): Promise<boolean> => {
  const output = resolve(options.output)
  if (existsSync(output)) throw new Error(`audit output already exists: ${output}; choose a new directory`)
  mkdirSync(output, { recursive: true })
  const retainedPaths: string[] = [output, ...Object.values(options.dirs), ...(options.retainedPaths ?? [])]
  const sides: Record<string, DeepSide> = {}
  for (const [cli, root] of Object.entries(options.dirs)) {
    const home = temporaryHome()
    retainedPaths.push(home)
    const program = JSON.parse(
      execFileSync("node", [join(root, "dist/bin", `${cli}.js`), "commands", "--json"], {
        encoding: "utf8",
        env: sandboxEnvironment(home),
      }),
    ) as CommandsJson
    sides[cli] = {
      root,
      snapshot: snapshot(root),
      program,
      sources: sourceEvidence(root),
      mounts: mountingEvidence(
        root,
        program.commands.map((one) => one.name),
        sourceEvidence(root),
      ),
      mcp: await captureTools(root, cli, program, retainedPaths),
      tests: { state: "not-run", checks: [], matrix: [], exclusions: [] },
    }
  }
  const sharedSnapshot = snapshot(options.root)
  const sharedSources = sourceEvidence(options.root)
  for (const [cli, side] of Object.entries(sides)) {
    side.tests = await testEvidence(side.root, cli, output, options.skipChecks === true, retainedPaths)
    const home = temporaryHome()
    retainedPaths.push(home)
    const profile = await check(
      options.root,
      `${cli}-search-profile`,
      ["node", join(options.root, "scripts/parity/search-profile.mjs"), side.root],
      join(output, `${cli}-search-profile.json`),
      sandboxEnvironment(home),
    )
    if (profile.exit === 0) side.searchProfile = readJson(profile.log)
    else side.searchProfileError = "pinned search exports could not be captured"
    for (const runtime of ["node", "bun"] as const) {
      const result = await check(
        options.root,
        `${cli}-${runtime}-consumer-fixture`,
        [
          runtime,
          join(options.root, "scripts/parity/consumer-fixture.mjs"),
          cli,
          side.root,
          join(options.root, "docs/search/recipes.json"),
        ],
        join(output, `${cli}-${runtime}-fixture.log`),
        sandboxEnvironment(home),
      )
      if (result.exit === 0) {
        try {
          const fixture = readJson<FixtureResult>(result.log)
          if (fixture.runtime !== runtime) throw new Error(`expected ${runtime} runtime`)
          if (runtime === "node") side.fixture = fixture
          else side.bunFixture = fixture
          if (fixture.temp) retainedPaths.push(fixture.temp)
        } catch (error) {
          side.fixtureError = `invalid ${runtime} fixture JSON: ${error instanceof Error ? error.message : String(error)}`
        }
      } else side.fixtureError = `${runtime} consumer fixture failed; see ${relative(output, result.log)}`
    }
    try {
      const remote = git(side.root, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]
      if (remote && remote !== side.snapshot.commit) side.movedTo = remote
    } catch {
      side.remoteError = "remote main could not be checked; captured local commit remains the evidence"
    }
  }
  const sharedTests = await testEvidence(options.root, "shared", output, options.skipChecks === true, retainedPaths)
  const [a, b] = Object.keys(sides)
  const left = a && sides[a]
  const right = b && sides[b]
  if (!left || !right || Object.keys(sides).length !== 2) throw new Error("deep comparison requires exactly two CLIs")
  const tools: DeepBundle["tools"] = {}
  for (const mode of CAPTURE_MODES) {
    const one = left.mcp.find((capture) => capture.mode === mode)
    const two = right.mcp.find((capture) => capture.mode === mode)
    if (one?.tools && two?.tools) tools[mode] = compareTools({ cli: a, tools: one.tools }, { cli: b, tools: two.tools })
  }
  const fixtureDifferences = [
    ...fixtureComparison(left.fixture, right.fixture).map((one) => `Node consumers: ${one}`),
    ...fixtureComparison(left.bunFixture, right.bunFixture).map((one) => `Bun consumers: ${one}`),
    ...fixtureComparison(left.fixture, left.bunFixture).map((one) => `${a} Node/Bun: ${one}`),
    ...fixtureComparison(right.fixture, right.bunFixture).map((one) => `${b} Node/Bun: ${one}`),
  ]
  const complete =
    !fixtureDifferences.length &&
    sharedTests.state === "ran" &&
    Object.values(sides).every(
      (side) =>
        side.tests.state === "ran" &&
        !side.fixtureError &&
        !side.searchProfileError &&
        side.mcp.every((capture) => !capture.error),
    )
  const bundle: DeepBundle = {
    schema: 1,
    capturedAt: new Date().toISOString(),
    manifest: options.manifest,
    shared: { root: options.root, snapshot: sharedSnapshot, sources: sharedSources, tests: sharedTests },
    sides,
    tools,
    comparison: comparePrograms(left.program, right.program),
    fixtureDifferences,
    searchProfileDifferences: valueDifferences(left.searchProfile, right.searchProfile),
    retainedPaths,
    complete,
  }
  writeJson(join(output, "evidence.json"), bundle)
  writeFileSync(join(output, "surface.md"), `${options.surface.trim()}\n`)
  renderReports(bundle, output)
  console.error(`deep audit: ${output}/report.md (${complete ? "checks passed" : "incomplete or failed checks"})`)
  return (
    complete ||
    (options.skipChecks === true &&
      !fixtureDifferences.length &&
      Object.values(sides).every(
        (side) => !side.fixtureError && !side.searchProfileError && side.mcp.every((capture) => !capture.error),
      ))
  )
}
