import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { linkFor } from "../../domain/links.js"
import { causeOf, gapsView, noticeView, type ScheduleFailure, weeklyGapsOf } from "./messages.js"
import { prepareMessage, REPORT_CHANNELS } from "./render.js"

const NOW = Date.parse("2026-11-09T08:35:00+03:00")
const ZONE = "Europe/Moscow"
const linkOf = (ref: string) => linkFor(ref, { form: "web", env: {} })

const digest = (gaps: unknown) =>
  JSON.stringify({
    format: "wirecat.report/1",
    kind: "morning-digest",
    date: "2026-11-05",
    sections: [],
    internal: { gaps, notes: "only for the developer" },
  })

const weekOfRuns = () => {
  const runs = mkdtempSync(join(tmpdir(), "weekly-gaps-"))
  const write = (stamp: string, text: string) => writeFileSync(join(runs, `${stamp}.md`), text)
  write("2026-11-02T06-30-00Z", digest([{ ref: "msg:email/9", what: "Письмо от «Вектора» не попало в почту дня" }]))
  write("2026-11-03T05-30-00Z", "```json\n" + digest([]) + "\n```")
  write(
    "2026-11-04T05-30-00Z",
    digest([
      { what: "письмо от Вектора не попало в почту дня!", refs: [], section: "mail" },
      { what: "Анна Котова ждёт ответа в WhatsApp", refs: ["chat:whatsapp/1001/4004"], section: "owed" },
    ]),
  )
  write(
    "2026-11-06T05-30-00Z",
    digest([
      { what: "Котова ждёт ответа про склад", refs: ["chat:whatsapp/1001/4004"], section: "owed" },
      { what: "Встреча в среду есть в календаре, а в списке встреч её нет `msg:email/11`", refs: [] },
      { what: "   ", refs: ["msg:email/10"] },
      "not a gap",
    ]),
  )
  write("2026-11-07T05-30-00Z", "The agent wrote Markdown this morning.")
  write(
    "2026-11-08T05-30-00Z",
    digest([{ what: "Анна Котова ждёт ответа в WhatsApp", ref: "chat:whatsapp/1001/4004" }]),
  )
  write("2026-11-01T05-30-00Z", digest([{ what: "старый пропуск, ему больше недели", refs: [] }]))
  writeFileSync(join(runs, "2026-11-08T05-30-00Z.log"), "stderr")
  return runs
}

const FAILURE: ScheduleFailure = {
  kind: "schedule-failed",
  tool: "memo",
  schedule: "morning-digest",
  at: "2026-11-09T08:31:00+03:00",
  since: "2026-11-07T08:31:00+03:00",
  failures: 3,
  cause: "sign-in",
  refs: ["sync:memo"],
}

describe("weekly gaps", () => {
  it("says each gap of a week of digests once, the most frequent first, and leaves the rest of the runs out", () => {
    const gaps = weeklyGapsOf(weekOfRuns(), NOW)

    expect(gaps.runs).toBe(5)
    expect(gaps.gaps).toEqual([
      {
        what: "Анна Котова ждёт ответа в WhatsApp",
        section: "owed",
        refs: ["chat:whatsapp/1001/4004"],
        seen: 3,
        first: "2026-11-04T05:30:00.000Z",
        last: "2026-11-08T05:30:00.000Z",
      },
      {
        what: "письмо от Вектора не попало в почту дня!",
        section: "mail",
        refs: ["msg:email/9"],
        seen: 2,
        first: "2026-11-02T06:30:00.000Z",
        last: "2026-11-04T05:30:00.000Z",
      },
      {
        what: "Встреча в среду есть в календаре, а в списке встреч её нет",
        section: null,
        refs: [],
        seen: 1,
        first: "2026-11-06T05:30:00.000Z",
        last: "2026-11-06T05:30:00.000Z",
      },
    ])
  })

  it("renders one message for Telegram, email and text, links only to the gaps' own refs", async () => {
    const gaps = weeklyGapsOf(weekOfRuns(), NOW)
    for (const language of ["ru", "en"]) {
      const message = await prepareMessage(
        "weekly-gaps",
        (shipped) => gapsView(gaps, { language: shipped, now: NOW, timeZone: ZONE, linkOf }),
        { language },
      )
      expect(message.reasons).toEqual([])
      for (const channel of REPORT_CHANNELS)
        await expect(message[channel]).toMatchFileSnapshot(`__snapshots__/weekly-gaps.${language}.${channel}.txt`)
    }
  })

  it("fits Telegram by dropping the last gaps and counting them", async () => {
    const many = weeklyGapsOf(weekOfRuns(), NOW)
    many.gaps = Array.from({ length: 15 }, (_, n) => ({
      ...many.gaps[0],
      what: `${n} ${"слово ".repeat(25)}`,
    })) as never
    const view = gapsView(many, { language: "ru", now: NOW, linkOf })
    const message = await prepareMessage("weekly-gaps", () => ({ ...view, items: [...view.items, ...view.items] }), {
      language: "ru",
    })
    expect(message.telegram.length).toBeLessThanOrEqual(4096)
    expect(message.telegram).toMatch(/ещё \d+$/)
  })
})

describe("the failed-schedule notice", () => {
  it.each(["ru", "en"])("renders which schedule, since when, why and one fix link in %s", async (language) => {
    const message = await prepareMessage(
      "schedule-failed",
      (shipped) => noticeView(FAILURE, { language: shipped, now: NOW, timeZone: ZONE, linkOf }),
      { language },
    )
    for (const channel of REPORT_CHANNELS)
      await expect(message[channel]).toMatchFileSnapshot(`__snapshots__/schedule-failed.${language}.${channel}.txt`)
    expect(message.telegram).toContain('<a href="https://wirecat.dev/o#/v1/sync/memo">')
  })

  it("says one failure by its day, and an unknown language falls back to English", async () => {
    const once = { ...FAILURE, failures: 1, since: FAILURE.at, cause: "network" as const }
    const message = await prepareMessage(
      "schedule-failed",
      (shipped) => noticeView(once, { language: shipped, now: NOW, timeZone: ZONE, linkOf }),
      { language: "de" },
    )
    expect(message.language).toBe("en")
    expect(message.text.split("\n")).toEqual([
      "⚠️ The morning digest could not be built",
      "Failed today at 08:31",
      "Why: the service could not be reached",
      "fix: https://wirecat.dev/o#/v1/sync/memo",
    ])
  })

  it.each([
    ["authentication_error", 1, "sign-in"],
    ["timeout", 1, "network"],
    ["configuration_error", 2, "setup"],
    [undefined, 143, "stopped"],
    [undefined, 1, "crashed"],
  ] as const)("reads %s with exit %s as %s", (code, exit, cause) => {
    expect(causeOf(code, exit)).toBe(cause)
  })
})
