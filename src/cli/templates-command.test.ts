import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { defaultTemplate, prepareReport } from "../background/report/render.js"
import { openCache } from "../store/open.js"
import { openStore, storedTemplateBodies } from "../store/store.js"
import type { Body } from "./envelope.js"
import { templatesCommand } from "./templates-command.js"

const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "synthetic", version: "1.0.0" }
const KEY = "report/morning-digest"
const SAMPLE = readFileSync(
  new URL("../background/report/templates/morning-digest.sample.json", import.meta.url),
  "utf8",
)

const fixture = (extra: NodeJS.ProcessEnv = {}) => {
  const root = mkdtempSync(join(tmpdir(), "templates-command-"))
  const env: NodeJS.ProcessEnv = {
    WIRECAT_STATE_DIR: root,
    FIXTURE_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "store.db"),
    ...extra,
  }
  const answers: Body[] = []
  const lines: string[] = []
  let edited = (_path: string) => {}
  const run = (...words: string[]) =>
    new Command("fixture")
      .exitOverride()
      .addCommand(
        templatesCommand(app, {
          env: () => env,
          output: (body) => answers.push(body),
          diagnostic: (line) => lines.push(line),
          editor: (path) => edited(path),
        }),
      )
      .parseAsync(["templates", ...words], { from: "user" })
  const item = () => {
    const last = answers.at(-1)
    return last && "item" in last ? (last.item as Record<string, unknown>) : {}
  }
  const file = (name: string, text: string) => {
    const path = join(root, name)
    writeFileSync(path, text)
    return path
  }
  return { env, root, run, item, file, lines, answers, onEdit: (fn: (path: string) => void) => (edited = fn) }
}

const shipped = (channel: "telegram" | "email" | "text", language = "ru") =>
  defaultTemplate("morning-digest", channel, language)

describe("templates", () => {
  it("saves a checked template, keeps the replaced body, and undo and reset bring the old ones back", async () => {
    const { run, item, file, answers } = fixture()
    const mine = `<b>Мой дайджест</b> {{ date.date }}\n${shipped("telegram")}`

    await run("show", KEY, "--channel", "telegram")
    expect(item()).toMatchObject({ source: "default", language: "ru", body: shipped("telegram"), history: [] })

    await run("edit", KEY, "--channel", "telegram", "--file", file("mine.liquid", mine))
    expect(item()).toMatchObject({ changed: true, updated_by: "fixture", checked_against: ["sample"] })
    await run("show", KEY, "--channel", "telegram")
    expect(item()).toMatchObject({ source: "stored", body: mine, history: [] })

    const second = mine.replace("Мой", "Наш")
    await run("edit", KEY, "--channel", "telegram", "--file", file("second.liquid", second))
    await run("show", KEY, "--channel", "telegram")
    expect(item()).toMatchObject({ body: second, history: [expect.objectContaining({ chars: mine.length })] })

    await run("edit", KEY, "--channel", "telegram", "--undo")
    await run("show", KEY, "--channel", "telegram")
    expect(item().body).toBe(mine)

    await run("reset", KEY, "--channel", "telegram")
    expect(item()).toMatchObject({ changed: true })
    await run("show", KEY, "--channel", "telegram")
    expect(item()).toMatchObject({ source: "default", body: shipped("telegram") })
    await run("edit", KEY, "--channel", "telegram", "--undo")
    await run("show", KEY, "--channel", "telegram")
    expect(item().body).toBe(mine)

    await run("list")
    const rows = (answers.at(-1) as { items: Record<string, unknown>[] }).items
    expect(rows).toContainEqual(
      expect.objectContaining({ key: KEY, channel: "telegram", language: "ru", source: "stored" }),
    )
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "report/weekly-gaps", channel: "text", renders: false, source: "none" }),
    )
  })

  it.each([
    ["telegram", "<u>{{ summary }}</u>", /would remove <u>/],
    ["telegram", '<a href="https://elsewhere.example/">x</a> {{ summary }}', /href that is not a link of the report/],
    ["email", "<img src=x> {{ summary }}", /would remove <img>/],
    ["text", "{% if %}", /does not render/],
    ["text", "{{ sections[0].nothing_here }}", /does not render/],
    ["text", "   ", /renders nothing/],
    ["telegram", `{{ "${"x".repeat(5000)}" }}`, /every item left out; Telegram takes 4096/],
  ] as const)("refuses a %s template that breaks a rule (%s) and stores nothing", async (channel, body, why) => {
    const { run, file, env } = fixture()

    await expect(run("edit", KEY, "--channel", channel, "--file", file("bad.liquid", body))).rejects.toThrow(why)

    const database = await openCache(env.MESSAGING_STORE as string)
    try {
      expect(storedTemplateBodies(database, KEY, "ru")).toEqual({})
    } finally {
      database.close()
    }
  })

  it("checks a save against the last real report too, and previews from it", async () => {
    const { run, item, file, env } = fixture()
    const runs = join(env.FIXTURE_STATE_DIR as string, "schedules", "digest", "runs")
    mkdirSync(runs, { recursive: true })
    const real = JSON.parse(SAMPLE) as { sections: { items: unknown[] }[] }
    real.sections = []
    writeFileSync(join(runs, "20261107-0800.report.json"), JSON.stringify(real))

    // The sample has sections; this real report has none, so only it catches the bad index.
    const fragile = "{{ sections[0].kind }}"
    await expect(run("edit", KEY, "--channel", "text", "--file", file("fragile.liquid", fragile))).rejects.toThrow(
      /20261107-0800\.report\.json: it does not render/,
    )

    await run("preview", KEY, "--channel", "text")
    expect(item()).toMatchObject({ template: "default", against: join(runs, "20261107-0800.report.json") })
    expect(item().problems).toEqual([])
    expect(String(item().text).length).toBeGreaterThan(0)

    await run("preview", KEY, "--channel", "telegram", "--file", file("draft.liquid", "<u>{{ summary }}</u>"))
    expect(item()).toMatchObject({ template_failed: false })
    expect(item().problems).toEqual(["the telegram rules would remove <u>", "the telegram rules would remove </u>"])
  })

  it("opens the editor on the template that applies, and keeps the draft when the check fails", async () => {
    const { run, item, lines, onEdit } = fixture({ VISUAL: "unused" })
    let seen = ""
    onEdit((path) => {
      seen = readFileSync(path, "utf8")
    })
    await run("edit", KEY, "--channel", "email", "--language", "en")
    expect(seen).toBe(shipped("email", "en"))
    expect(item()).toMatchObject({ changed: false })
    expect(lines.at(-1)).toMatch(/unchanged; nothing saved/)

    let draft = ""
    onEdit((path) => {
      draft = path
      writeFileSync(path, "<script>x</script>{{ summary }}")
    })
    await expect(run("edit", KEY, "--channel", "email", "--language", "en")).rejects.toThrow(
      /not saved — sample: the email rules would remove <script> and its content\. Your text is in .*--file/,
    )
    expect(readFileSync(draft, "utf8")).toMatch(/<script>/)
  })

  it("lets only the owner change a template, and refuses keys nothing renders and languages never used", async () => {
    const agent = fixture({ CLAUDECODE: "1" })
    await expect(
      agent.run("edit", KEY, "--channel", "text", "--file", agent.file("a", "{{ summary }}")),
    ).rejects.toThrow(/only the owner changes a message template/)
    await expect(agent.run("reset", KEY, "--channel", "text")).rejects.toThrow(/only the owner/)
    await agent.run("show", KEY, "--channel", "text")

    const { run } = fixture()
    await expect(run("show", "report/weekly-gaps", "--channel", "text")).rejects.toThrow(
      /nothing renders report\/weekly-gaps yet/,
    )
    await expect(run("show", "report/nope", "--channel", "text")).rejects.toThrow(/no template report\/nope/)
    await expect(run("show", KEY, "--channel", "text", "--language", "de")).rejects.toThrow(
      /en, ru; a de one would never/,
    )
  })

  it("delivers with a stored template, and falls back to the shipped one when a stored body fails", async () => {
    const { env } = fixture()
    const store = await openStore({ env })
    store.templates.save({ key: KEY, channel: "text", language: "ru" }, "МОЙ {{ summary }}", "fixture")
    store.templates.save({ key: KEY, channel: "telegram", language: "ru" }, "{{ nothing_here }}", "fixture")
    await store.close()
    const templates = async (kind: string, language: string) => {
      const database = await openCache(env.MESSAGING_STORE as string)
      try {
        return storedTemplateBodies(database, `report/${kind}`, language)
      } finally {
        database.close()
      }
    }

    const prepared = await prepareReport(SAMPLE, {
      language: "ru",
      now: Date.parse("2026-11-06T08:30:00+03:00"),
      templates,
    })

    expect(prepared?.text).toBe("МОЙ Two replies are waiting, one payment is overdue.")
    expect(prepared?.telegram).toMatch(/Two replies are waiting/)
    expect(prepared?.run.reasons).toEqual(["report.template-failed"])
    const failing = await prepareReport(SAMPLE, {
      language: "ru",
      now: 0,
      templates: async () => {
        throw new Error("store locked")
      },
    })
    expect(failing?.run.reasons).toEqual(["report.template-failed"])
  })
})
