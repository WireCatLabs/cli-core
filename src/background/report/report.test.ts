import { describe, expect, it } from "vitest"
import { TELEGRAM_TEXT_CHARS } from "../deliver.js"
import { prepareReport, renderReport } from "./render.js"
import { parseReport } from "./schema.js"
import { reportView } from "./view.js"

const NOW = Date.parse("2026-11-06T08:30:00+03:00")
const ZONE = "Europe/Moscow"

const digest = (sections: unknown[] = SECTIONS, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: "wirecat.report/1",
    kind: "morning-digest",
    date: "2026-11-06",
    summary: "Три ответа ждут вас, один платёж просрочен.",
    sections,
    health: [
      { source: "MAX", stale_hours: 50, refs: ["account:max/1"] },
      { source: "почта Gmail", stale_hours: 3 },
    ],
    internal: { gaps: [{ ref: "msg:email/9", what: "не проверено", section: "owed" }], notes: "секрет" },
    ...extra,
  })

const SECTIONS = [
  {
    kind: "money",
    items: [
      {
        type: "money",
        who: "ООО «Вектор»",
        topic: "аренда за ноябрь",
        action: "оплатить",
        amount: { value: 48000, currency: "RUB", direction: "out" },
        due: "2026-11-03",
        channel: "mail",
        refs: ["msg:email/7"],
      },
      {
        type: "money",
        who: "ИП Смирнова",
        topic: "предоплата по договору 14",
        amount: { value: 120000, currency: "RUB", direction: "in" },
      },
    ],
  },
  {
    kind: "today",
    items: [
      {
        type: "reply",
        who: "Анна Котова",
        topic: "аренда склада",
        action: "Ответить, подходит ли подписание в пятницу",
        quote: "Сможем подписать в пятницу?",
        since: "2026-11-04T14:20:00+03:00",
        channel: "mail",
        refs: ["msg:email/1"],
        links: [{ kind: "web", url: "https://attacker.example/", label: "письмо" }],
      },
      {
        type: "question",
        who: "Игорь Лапин",
        topic: "поставка плитки",
        action: "можно ли перенести поставку плитки на 20-е?",
        since: "2026-11-05T19:00:00+03:00",
        channel: "telegram",
      },
      { type: "task", topic: "Акт сверки для «Северного ветра»", due: "2026-11-04" },
      { type: "task", topic: "Смета «Ремонт офиса»", due: "2026-11-06T18:00:00+03:00", who: "Марина Орлова" },
    ],
  },
  {
    kind: "decisions",
    items: [{ type: "decision", topic: "Находки из почты", action: "ждут проверки", count: 12 }],
  },
  {
    kind: "meetings",
    items: [
      {
        type: "meeting",
        topic: "Планёрка по складу",
        time: "2026-11-06T11:00:00+03:00",
        who: "Анна Котова, Пётр Белов",
        action: "подготовить цифры по аренде",
      },
    ],
  },
  {
    kind: "projects",
    items: [
      {
        type: "fact",
        topic: "Склад в Химках",
        detail: "арендодатель согласовал скидку 5% с января",
        who: "Анна Котова",
      },
      {
        type: "risk",
        topic: "Поставка кабеля",
        detail: "поставщик не отвечает 4 дня",
        action: "позвонить Петру Белову до обеда",
      },
    ],
    more: 2,
  },
]

const options = { language: "ru", now: NOW, timeZone: ZONE }

const viewOf = (text: string, language = "ru") => {
  const parsed = parseReport(text)
  if (!parsed || "invalid" in parsed) throw new Error(`not a report: ${JSON.stringify(parsed)}`)
  return reportView(parsed.report, { language, now: NOW, timeZone: ZONE })
}

describe("a wirecat.report/1 document", () => {
  it.each(["telegram", "email", "text"] as const)("renders the ru digest for %s", async (channel) => {
    const rendering = await renderReport(viewOf(digest()), channel)
    expect(rendering).toMatchObject({ templateFailed: false, templateTags: 0 })
    const extension = channel === "text" ? "txt" : "html"
    await expect(`${rendering.text}\n`).toMatchFileSnapshot(`__snapshots__/morning-digest.ru.${channel}.${extension}`)
    expect(rendering.text).not.toMatch(/msg:|account:|attacker|секрет|owed/)
  })
})

describe("the platform rules", () => {
  it("drops the last item of the largest section until Telegram's limit fits, and counts it in more", async () => {
    const many = Array.from({ length: 40 }, (_, n) => ({
      type: "fact",
      topic: `Проект ${n}`,
      detail: "д".repeat(150),
      who: "Анна Котова",
    }))
    const view = viewOf(digest([...SECTIONS, { kind: "mail", items: many }]))
    view.sections = view.sections.map((section) =>
      section.kind === "mail" ? { ...section, items: [...section.items, ...section.items, ...section.items] } : section,
    )
    const { text } = await renderReport(view, "telegram")
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_CHARS)
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_CHARS - 400)
    const shown = text.match(/<b>Проект \d+<\/b>/g)?.length ?? 0
    expect(text).toContain(`ещё ${15 - shown + 35}`)
    expect(text).toContain("Акт сверки")
  })

  it("escapes markup an agent wrote, so mail text cannot add a tag or a link", async () => {
    const injected = [
      {
        kind: "today",
        items: [
          {
            type: "reply",
            who: 'Злоумышленник <a href="https://evil.example">клик</a>',
            topic: "<b>срочно</b> & важно",
            action: "%3Cscript%3E ответить",
            since: "2026-11-05T08:00:00+03:00",
          },
        ],
      },
    ]
    for (const channel of ["telegram", "email"] as const) {
      const { text, templateTags } = await renderReport(viewOf(digest(injected)), channel)
      expect(text).toContain("Злоумышленник &lt;a href=&quot;https://evil.example&quot;&gt;клик&lt;/a&gt;")
      expect(text).toContain("&lt;b&gt;срочно&lt;/b&gt; &amp; важно")
      expect(text).not.toContain("<a ")
      expect(templateTags).toBe(0)
    }
  })

  it("strips what a template may not write: other tags, a style block, a link to anywhere", async () => {
    const template =
      '<u>{{ date.date }}</u><style>b{}</style> <a href="https://evil.example">x</a> <b onclick="y">{{ sections.size }}</b>'
    const { text, templateTags, templateFailed } = await renderReport(viewOf(digest()), "telegram", { template })
    expect(text).toBe("6 ноября x <b>5</b>")
    expect(templateTags).toBe(5)
    expect(templateFailed).toBe(false)
  })

  it("falls back to the shipped template when a template fails, for that channel only", async () => {
    const view = viewOf(digest())
    const broken = await renderReport(view, "telegram", { template: "{{ sections[0].nothing_here }}" })
    expect(broken.templateFailed).toBe(true)
    expect(broken.text).toBe((await renderReport(view, "telegram")).text)
    const prepared = await prepareReport(digest(), { ...options, templates: { telegram: "{% if %}" } })
    expect(prepared?.run.reasons).toEqual(["report.template-failed"])
    expect(prepared?.text).toBe((await renderReport(view, "text")).text)
  })
})

describe("an answer as a report", () => {
  it("keeps Markdown and plain text out of it", () => {
    expect(parseReport("# Today\n- three things")).toBeUndefined()
    expect(parseReport("Сводка: всё спокойно")).toBeUndefined()
  })

  it("takes one fenced json block, and counts what leaked out of the agent's strings", async () => {
    const leaky = [
      {
        kind: "mail",
        items: [{ type: "fact", topic: "Счёт `msg:email/5`", detail: "из mail_findings, см. --since-time" }],
      },
    ]
    const prepared = await prepareReport(`\`\`\`json\n${digest(leaky)}\n\`\`\``, options)
    expect(prepared?.run).toEqual({ language: "ru", leaks: 4 })
    expect(prepared?.text).toContain("ℹ️ Счёт: из , см.")
    expect(prepared?.subject).toBe("☀️ Сводка на пятницу, 6 ноября")
  })

  it.each([
    ["sections[0].items[0].type", [{ kind: "today", items: [{ type: "joke", topic: "x" }] }]],
    ["sections[0].items[0].since", [{ kind: "today", items: [{ type: "reply", who: "a", topic: "b", action: "c" }] }]],
    ["sections[0].kind", [{ kind: "health", items: [] }]],
  ])("refuses a document that fails at %s, and shows one line instead", async (path, sections) => {
    const prepared = await prepareReport(digest(sections), options)
    expect(prepared).toMatchObject({
      invalid: true,
      text: "Сводка не собралась: ошибка формата. Подробности в WireCat.",
      run: { invalid: path, reasons: ["delivery.report-invalid"] },
    })
    expect((await prepareReport("{ not json", { ...options, language: "en" }))?.text).toMatch(/^The report could/)
  })

  it("renders in English, and in English words for a language with no template", async () => {
    const english = await prepareReport(digest(), { ...options, language: "es" })
    expect(english?.run.language).toBe("en")
    expect(english?.subject).toBe("☀️ Digest for Friday, November 6")
    expect(english?.text).toContain("🔥 Today\n💬 Анна Котова · аренда склада")
  })

  it("says a quiet day, and does not call it calm while a source is stale", async () => {
    expect((await prepareReport(digest([]), options))?.text).toContain("Новых дел нет, но MAX не обновлялся 2 дня.")
    const fresh = await prepareReport(digest([], { health: [] }), options)
    expect(fresh?.text).toContain("Тихое утро: ничего срочного.")
  })
})
