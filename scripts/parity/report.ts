import { writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { commandMap, type Difference, inlineJson } from "../../dist/parity/deep.js"
import type { DeepBundle, DeepSide, Snapshot } from "./deep-audit.ts"
import type { TestEvidence } from "./evidence.ts"

const lines = (output: string, file: string, contents: string[]) =>
  writeFileSync(join(output, file), `${contents.join("\n").trim()}\n`)
const changes = (diffs: Difference[]) =>
  diffs.map((one) => `- ${one.path}: ${inlineJson(one.left)} → ${inlineJson(one.right)}`)
const evidenceLink = (root: string, snapshot: Snapshot, file: string, line?: number) => {
  if (snapshot.dirty) return `[${file}${line ? `:${line}` : ""}](${join(root, file)}${line ? `:${line}` : ""})`
  if (!snapshot.repository) return `[${file}](${join(root, file)})`
  return `[${file}${line ? `:${line}` : ""}](${snapshot.repository}/blob/${snapshot.commit}/${file}${line ? `#L${line}` : ""})`
}
const matrixStatus = (side: DeepSide, path: string, option = "") => {
  const row = side.tests.matrix.find(
    (one) => one.command === (path === "(global)" ? "*global*" : path) && one.option === option,
  )
  return row
    ? `${row.status}${row.reason ? ` — ${row.reason}` : ""}`
    : "not recorded in this run's argv matrix; no semantic coverage inferred"
}
const current = (bundle: DeepBundle) => Object.entries(bundle.sides)

export const renderReports = (bundle: DeepBundle, output: string): void => {
  const sides = current(bundle)
  const common = bundle.comparison.commands.filter((one) => one.present.length === sides.length)
  const divergent = common.filter((one) => one.contracts.length)
  const prose = common.filter((one) => !one.contracts.length && one.help.length)
  const report = [
    "# Detailed parity evidence",
    "",
    `Captured ${bundle.capturedAt}.`,
    "",
    "## What these results prove",
    "",
    "This is a measured evidence bundle and a review draft. Matching names/imports, manifest checks and high coverage do not prove identical behaviour. Intentional protocol differences and remaining ownership require source/test review.",
    "",
    `- Collection/check state: **${bundle.complete ? "all requested checks completed successfully" : "incomplete, skipped or failed — inspect tests and capture errors"}**.`,
    `- Actual command/group paths in both: **${common.length}**; structural contract differences: **${divergent.length}**; further prose-only differences: **${prose.length}**.`,
    `- Global contract differences: ${bundle.comparison.globals.length}; global prose differences: ${bundle.comparison.globalHelp.length}.`,
    "- These counts are command/group paths, not manifest rows, runnable actions or tests.",
    "- [Every command, argument, flag, default and matrix row](commands.md)",
    "- [Every MCP schema, annotation and visibility mode](mcp.md)",
    "- [Fresh tests, skips, coverage and exclusions](tests.md)",
    "- [Functional groups and mounting/source candidates](functions.md)",
    "- [Registration/import/service source evidence](sources.md)",
    "- [Common synthetic consumer scenarios](scenarios.md)",
    "- [Pinned search fields/operators/budgets](search.md)",
    "- [Manifest/pages/release tooling measurements](surface.md)",
    "- [Complete machine evidence](evidence.json)",
    "",
    "## Snapshots and package pins",
    "",
    `- shared: ${bundle.shared.snapshot.commit}, version ${bundle.shared.snapshot.version}.`,
    ...sides.map(
      ([cli, side]) =>
        `- ${cli}: ${side.snapshot.commit}, version ${side.snapshot.version}, pins ${inlineJson(side.snapshot.pins)}${side.movedTo ? `; main moved during measurement to ${side.movedTo}; results remain for the captured commit` : ""}.`,
    ),
    ...[["shared", bundle.shared.snapshot] as const, ...sides.map(([cli, side]) => [cli, side.snapshot] as const)]
      .filter(([, snapshot]) => snapshot.dirty)
      .map(
        ([cli]) =>
          `- ${cli}: working tree was dirty before measurement; source links point to local evidence, not an immutable clean snapshot.`,
      ),
    "",
    "## CLI differences to interpret",
    "",
    ...bundle.comparison.commands
      .filter((one) => one.present.length < sides.length)
      .map((one) => `- Only ${one.present.join(", ")}: ${one.path}.`),
    ...divergent.flatMap((one) => [``, `### ${one.path}`, "", ...changes(one.contracts)]),
    "",
    "## MCP visibility and structural differences",
    "",
    "Modes describe flags/configuration, not permission verdicts. Default visibility is not necessarily read-only. Configured exposure includes source-declared opt-in tool groups where present. Failed captures are not empty tool lists.",
    "",
  ]
  for (const mode of ["default", "send", "flags", "configured"]) {
    const tools = bundle.tools[mode]
    const captures = sides.map(
      ([cli, side]) => `${cli}: ${side.mcp.find((one) => one.mode === mode)?.tools?.length ?? "capture failed"}`,
    )
    report.push(
      `- ${mode}: ${captures.join("; ")}; shared structural mismatches ${tools?.filter((one) => one.present.length === sides.length && one.contracts.length).length ?? "unknown"}.`,
    )
  }
  report.push(
    "",
    "## Functions and implementation review",
    "",
    "The source appendix includes every production import/export, literal command/tool registration and service call candidate with line anchors. It is lexical evidence, not a resolved call graph. For each functional group, inspect the command/MCP → service → adapter route and classify shared, mixed/local, protocol-specific, owned migration or unknown. Do not fill unresolved routes with guesses.",
    "",
    "Manifest declarations and ownership hints are preserved in evidence.json. A planned/exempt row is not a successful implementation or test; trace it to current source and claims before assigning a finding.",
    "",
    "## Search and behaviour",
    "",
    ...sides.map(
      ([cli, side]) =>
        `- ${cli}: ${side.fixture ? `${side.fixture.results.length} search positive/negative recipes; ${side.fixture.reads.length} read/diagnostic scenarios; ${side.fixture.checks?.length ?? 0} behavioural checks; Node and ${side.bunFixture ? "Bun" : "Bun capture missing"}; ${side.fixture.networkAttempts} attempted connections` : (side.fixtureError ?? "not checked")}.`,
    ),
    `- Cross-consumer differences: ${bundle.fixtureDifferences.length ? bundle.fixtureDifferences.join("; ") : "none for the recorded recipes/reads"}.`,
    "- The corpus checks documented local search, not every Lucene operator, full remote archive, bot search or model quality. Query parser/service/CLI/MCP tests are listed individually; recipes do not replace those contracts.",
    "",
    "## Limits and work to do",
    "",
    "- Review each structural and result mismatch against code/tests/protocol evidence; source imports do not prove equivalent use cases.",
    "- A matrix check means an invocation occurred, not that all values/errors/combinations were asserted. An exemption or skipped test is not a pass.",
    "- Coverage is per repository, excludes declared files, and does not count dependency code inside the consumers. Compare relevant files/branches, not total test counts as a quality ranking.",
    "- No live account, sends, read acknowledgements, installed CLI self-upgrade, real OS/model/browser workflow, new Java reference or performance benchmark was run. Bot MCP visibility needs separate configured synthetic integration; personal MCP counts do not describe bots.",
    "- Turn this draft into the interpreted audit: explain terms, functional parity, source routes, tested/untested behaviour, intentional reasons, owners and next actions. Link the preceding audit and preserve its snapshot.",
    "",
    "## Retained artifacts",
    "",
    ...bundle.retainedPaths.map((path) => `- ${path}`),
  )
  lines(output, "report.md", report)

  const commands = [
    "# Every command and option",
    "",
    "All actual paths, including groups. Defaults absent in discovery may be resolved by settings. These rows do not prove semantic parity.",
    "",
  ]
  for (const path of ["(global)", ...bundle.comparison.commands.map((one) => one.path)]) {
    commands.push(`## ${path}`, "")
    for (const [cli, side] of sides) {
      const node = path === "(global)" ? undefined : commandMap(side.program).get(path)
      if (path !== "(global)" && !node) {
        commands.push(`- ${cli}: absent.`)
        continue
      }
      if (node)
        commands.push(
          `- ${cli}: ${inlineJson(node.usage)}, ${node.description}; arguments ${inlineJson(node.arguments)}; mutates ${inlineJson(node.mutates)}, state ${inlineJson(node.state)}; argv ${matrixStatus(side, path)}.`,
        )
      for (const option of node?.options ?? (path === "(global)" ? side.program.global_options : [])) {
        const name = option.flags.match(/--[\w-]+/)?.[0] ?? option.flags
        commands.push(`  - ${cli} ${inlineJson(option)}; argv ${matrixStatus(side, path, name)}.`)
      }
    }
    commands.push("")
  }
  lines(output, "commands.md", commands)

  const mcp = [
    "# MCP tools, schemas and visibility",
    "",
    "Schema collection invokes no tools; separate synthetic tool calls are recorded in scenarios.md. Required/enum/choices sets ignore order for structural comparison; positional arrays keep order. Missing outputSchema is unknown output validation, not proof of equal results.",
    "",
  ]
  for (const mode of ["default", "send", "flags", "configured"]) {
    mcp.push(`## ${mode}`, "")
    for (const [cli, side] of sides) {
      const capture = side.mcp.find((one) => one.mode === mode)
      mcp.push(
        `### ${cli}`,
        "",
        `Arguments: ${inlineJson(capture?.argv)}; synthetic config: ${inlineJson(capture?.config)}.`,
        "",
      )
      if (capture?.error) mcp.push(`Capture failed: ${capture.error}.`, "")
      for (const tool of capture?.tools ?? []) {
        mcp.push(
          `#### ${tool.name}`,
          "",
          `Input: ${inlineJson(tool.inputSchema)}`,
          "",
          `Annotations: ${inlineJson(tool.annotations)}`,
          "",
          `Output: ${tool.outputSchema ? inlineJson(tool.outputSchema) : "no outputSchema declared"}`,
          "",
        )
      }
    }
    for (const tool of bundle.tools[mode] ?? []) {
      if (tool.present.length < sides.length) mcp.push(`- ${tool.name}: only ${tool.present.join(", ")}.`)
      else if (tool.contracts.length) mcp.push(`- ${tool.name}: structural differences`, ...changes(tool.contracts))
    }
  }
  lines(output, "mcp.md", mcp)

  const tests = [
    "# Tests and coverage",
    "",
    "Only evidence from this run. Missing artifacts/skipped checks are not reused from an earlier run.",
    "",
  ]
  const testSide = (cli: string, root: string, snapshot: Snapshot, one: TestEvidence) => {
    tests.push(
      `## ${cli}`,
      "",
      `State: ${one.state}; passed ${one.results?.numPassedTests ?? "unknown"}; failed ${one.results?.numFailedTests ?? "unknown"}; pending ${one.results?.numPendingTests ?? "unknown"}.`,
      "",
    )
    for (const gate of one.checks)
      tests.push(
        `- ${gate.name}: exit ${gate.exit}, ${gate.milliseconds} ms${gate.error ? `, ${gate.error}` : ""}; [log](${relative(output, gate.log).replaceAll("\\", "/")}).`,
      )
    tests.push("", "### Every test file", "")
    for (const suite of one.results?.testResults ?? []) {
      const file = relative(root, suite.name).replaceAll("\\", "/")
      const passed = suite.assertionResults.filter((test) => test.status === "passed").length
      tests.push(
        `- ${evidenceLink(root, snapshot, file)}: ${passed} passed, ${suite.assertionResults.length - passed} non-passed.`,
      )
      for (const test of suite.assertionResults.filter((test) => test.status !== "passed"))
        tests.push(`  - ${test.status}: ${test.fullName}`)
    }
    tests.push("", "### Every production file", "", "| File | Lines | Branches | Functions |", "|---|---:|---:|---:|")
    for (const [name, coverage] of Object.entries(one.coverage ?? {})) {
      const file = name === "total" ? "total" : evidenceLink(root, snapshot, relative(root, name).replaceAll("\\", "/"))
      tests.push(
        `| ${file} | ${coverage.lines.pct}% (${coverage.lines.covered}/${coverage.lines.total}) | ${coverage.branches.pct}% (${coverage.branches.covered}/${coverage.branches.total}) | ${coverage.functions.pct}% |`,
      )
    }
    tests.push(
      "",
      "### Exact coverage configuration",
      "",
      "```ts",
      ...one.exclusions,
      "```",
      "",
      "### argv exceptions",
      "",
    )
    for (const row of one.matrix.filter((row) => row.status !== "✅"))
      tests.push(`- ${row.command} ${row.option}: ${row.status}; ${row.reason}`)
    tests.push("")
  }
  testSide("shared", bundle.shared.root, bundle.shared.snapshot, bundle.shared.tests)
  for (const [cli, side] of sides) testSide(cli, side.root, side.snapshot, side.tests)
  lines(output, "tests.md", tests)

  const search = [
    "# Search contract of the pinned packages",
    "",
    "Collected from each consumer's installed shared exports. Declared fields/operators are not a remote backend or proof that every operator was exercised. Personal search, bot legacy search, semantic embeddings and name filters remain distinct workflows.",
    "",
  ]
  for (const [cli, side] of sides)
    search.push(`## ${cli}`, "", side.searchProfileError ?? inlineJson(side.searchProfile), "")
  search.push(
    "## Direct export differences",
    "",
    ...changes(bundle.searchProfileDifferences),
    "",
    "See scenarios.md for actual consumer results and tests.md for parser, date/DST, service, CLI/MCP and regex corpus coverage; Java/benchmarks were not rerun.",
  )
  lines(output, "search.md", search)

  const functions = [
    "# Functional groups and implementation evidence",
    "",
    "Factory bindings are lexical evidence from program.ts, not proof of identical service/adapter behaviour. Unresolved or mixed groups stay explicit; all exact command differences remain in commands.md.",
    "",
  ]
  for (const group of [...new Set(sides.flatMap(([, side]) => side.program.commands.map((one) => one.name)))].sort()) {
    functions.push(`## ${group}`, "")
    for (const [cli, side] of sides) {
      const mount = side.mounts.find((one) => one.group === group)
      if (!mount) {
        functions.push(`- ${cli}: group absent.`)
        continue
      }
      functions.push(`- ${cli}: ${mount.verdict}; binding ${inlineJson(mount.binding)}.`)
      if (mount.file) functions.push(`  - Mount: ${evidenceLink(side.root, side.snapshot, mount.file)}.`)
      for (const line of [...mount.sharedReferences, ...mount.localRegistrations])
        functions.push(`  - ${evidenceLink(side.root, side.snapshot, line.file, line.line)}: ${inlineJson(line.text)}`)
      const rows = side.tests.matrix.filter((one) => one.command === group || one.command.startsWith(`${group} `))
      functions.push(
        `  - argv rows: ${rows.filter((one) => one.status === "✅").length} invoked, ${rows.filter((one) => one.status !== "✅").length} exceptions/missing. This does not measure semantic completeness.`,
      )
    }
    functions.push("")
  }
  lines(output, "functions.md", functions)

  const sources = [
    "# Production source evidence",
    "",
    "Lexical import/definition/registration/service-call candidates. Mixed or dynamic registration requires review; this is not an AST call graph or a declaration of functional equality.",
    "",
  ]
  for (const [cli, one] of [["shared", bundle.shared] as const, ...sides]) {
    sources.push(`## ${cli}`, "")
    let previous = ""
    for (const source of one.sources) {
      if (source.file !== previous) {
        sources.push(`### ${source.file}`, "")
        previous = source.file
      }
      sources.push(
        `- ${evidenceLink(one.root, one.snapshot, source.file, source.line)} (${source.kind}): ${inlineJson(source.text)}`,
      )
    }
    sources.push("")
  }
  lines(output, "sources.md", sources)
  lines(output, "scenarios.md", [
    "# Synthetic consumer scenarios",
    "",
    "Only local store, offline/no-record, disposable home and memory keyring. Store-check comparison ignores only path, disk.free and wordIndex.builtAt. Search compares exact ids/error reasons/metadata keys; it does not claim identical provider-qualified locators.",
    "",
    ...sides.flatMap(([cli, side]) => [
      `## ${cli}`,
      "",
      ...(side.fixture?.results.map((result) => `- ${inlineJson(result)}`) ?? [side.fixtureError ?? "not run"]),
      ...(side.fixture?.checks?.map((one) => `- ${one.name}: ${one.pass ? "pass" : "FAIL"}`) ?? []),
      `- Bun: ${side.bunFixture?.results.length ?? 0} recipes; ${side.bunFixture?.checks?.length ?? 0} checks; ${side.bunFixture?.networkAttempts ?? "unknown"} attempted connections.`,
      ...(side.fixture?.reads.map((read) => `- ${read.argv.join(" ")}: exit ${read.code}`) ?? []),
      "",
    ]),
    "## Differences",
    "",
    ...bundle.fixtureDifferences.map((one) => `- ${one}`),
  ])
}
