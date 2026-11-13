import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import type { RunMetadata } from "../runs/run.js"
import { runsDirFor } from "../runs/run.js"
import type { SendEntry } from "../sends/journal.js"
import { type BaseContext, environmentOf, outputFor } from "./context.js"
import { destroysNothing, LOCAL_WRITE, NO_EFFECTS } from "./effects.js"
import { itemOf, renderAnswer } from "./envelope.js"
import { buildReport, reportFileName } from "./messenger/report.js"
import { ownPackageRoot } from "./messenger/serve-outdated.js"
import { lineOf, nextStep, rootOf } from "./steps.js"

export interface DoctorReportsSource {
  app: AppIdentity
  /** What the file holds and never holds, as `doctor reports show` lists it. */
  includes: readonly string[]
  excludes: readonly string[]
  /** The words before `doctor reports create` in its example: `tg personal` for a messenger. */
  example: string
  /** Said before sending, after "read it before sending: ". */
  check: string
  /** What `doctor --json` answers, and the newest write attempts; `renderer` when the doctor resolved its own. */
  collect: (
    command: Command,
  ) => Promise<{ doctor: Record<string, unknown>; sends: SendEntry[]; renderer?: BaseContext["renderer"] }>
}

const writeNew = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, text, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new CliError("validation_error", `${path} exists — a problem report never overwrites a file`, {
      reason: "doctor.report-exists",
    })
  }
}

const urlOf = (field: unknown): string | undefined => {
  const url = typeof field === "string" ? field : (field as { url?: unknown } | undefined)?.url
  return typeof url === "string" ? url : undefined
}

/**
 * The new-issue page: the app definition's `issues`, else the GitHub repository its installed package names in
 * `bugs` or `repository`. Only GitHub's: the link fills the issue through GitHub's own parameters.
 */
export const issuesPage = (app: AppIdentity, script = process.argv[1]): string | undefined => {
  if (app.issues) return app.issues
  const root = ownPackageRoot(app.version, script)
  if (!root) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>
    const repository = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/issues)?\/?$/.exec(
      urlOf(manifest.bugs) ?? urlOf(manifest.repository) ?? "",
    )
    return repository ? `https://github.com/${repository[1]}/${repository[2]}/issues/new` : undefined
  } catch {
    return undefined
  }
}

/**
 * A new issue with its title and body filled in through GitHub's `title` and `body` parameters. An issue is public, so
 * the body holds only the version, the platform and the failed run's codes; the person attaches the file.
 */
export const issueUrlFor = (
  app: AppIdentity,
  run: RunMetadata | undefined,
  platform = process.platform,
  arch = process.arch,
) => {
  const code = run ? (run.errorCode ?? "failed") : undefined
  const body = [
    "What I did:",
    "",
    "What I expected:",
    "",
    "What happened:",
    "",
    "---",
    `${app.command} ${app.version}, ${platform} ${arch}`,
    ...(code ? [`error: ${code}${run?.providerError ? ` (${run.providerError})` : ""}`] : []),
    "The problem report file is attached.",
  ].join("\n")
  const title = `${app.command} ${app.version}: ${code ?? "problem report"}`
  return `${app.issues}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

/** `doctor reports show|create`: one file for the author, the same for every CLI; `collect` says what it holds. */
export const doctorReportsCommand = (source: DoctorReportsSource): Command => {
  const { app, includes, excludes } = source
  const reports = annotate(new Command("reports"), { effects: NO_EFFECTS }).description("problem reports")
  annotate(reports.command("show"), {
    effects: NO_EFFECTS,
    examples: [`${app.command} doctor reports show`],
  })
    .description("what a problem report holds; writes nothing")
    .summary("what a report holds and never holds, and where to send it; writes nothing")
    .action(function (this: Command) {
      const create = lineOf(this, "doctor reports create")
      const page = issuesPage(app)
      renderAnswer(
        this,
        outputFor(this),
        itemOf(
          { includes, excludes, ...(page ? { send_to: page } : {}) },
          { next: [nextStep("doctor.report-create", { args: {} })] },
        ),
        () =>
          [
            `A problem report is one file for the author of ${app.command}.`,
            "",
            "It holds:",
            ...includes.map((line) => `- ${line}`),
            "",
            `It never holds: ${excludes.join(", ")}.`,
            "",
            `Create one:          ${create}`,
            `About a given run:   ${create} --run <id>   (ids: ${lineOf(this, "runs list")})`,
          ].join("\n"),
      )
    })
  destroysNothing(
    annotate(reports.command("create"), {
      effects: LOCAL_WRITE,
      examples: [`${source.example} doctor reports create --output ./problem-report.json`],
    }),
  )
    .description("write a problem report to a file, and say where to send it")
    .summary("the report file written: its path, the run it is about, and where to send it")
    .option("--run <id>", "the run the report is about; the newest failed one if not given")
    .option("--output <file>", "where to write it; a new file in this directory if not given")
    .action(async function (this: Command) {
      const given = this.opts<{ run?: string; output?: string }>()
      const env = environmentOf(this).env ?? process.env
      const { doctor, sends, renderer } = await source.collect(this)
      const now = new Date()
      const built = buildReport({
        doctor,
        runsDir: runsDirFor(app, env),
        command: app.command,
        sends,
        now,
        home: env.HOME ?? env.USERPROFILE,
        program: rootOf(this),
        ...(given.run === undefined ? {} : { runId: given.run }),
      })
      const path = resolve(given.output ?? reportFileName(app.command, now))
      writeNew(path, `${JSON.stringify(built, null, 2)}\n`)
      const output = outputFor(this)
      const out = renderer ?? output.renderer
      const page = issuesPage(app)
      const issue = page ? issueUrlFor({ ...app, issues: page }, built.run?.metadata) : undefined
      renderAnswer(
        this,
        { ...output, renderer: out },
        itemOf({
          path,
          run: built.run?.metadata.runId ?? null,
          ...(issue ? { send_to: page, issue_url: issue } : {}),
        }),
      )
      if (!built.run)
        out.note("no failed run is recorded — run the failing command again, and the failure is kept by itself")
      out.note(
        `read it before sending: ${source.check}${issue ? ` — then open ${issue} and attach the file; the issue is public` : ""}`,
      )
    })
  return reports
}
