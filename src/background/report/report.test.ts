import { describe, expect, it } from "vitest"
import { type LinkForm, linkFor, parseLink } from "../../domain/links.js"
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
      {
        source: "Telegram",
        account: "@ownerdemo",
        reason: "sync-failed",
        since: "2026-11-04T23:10:00+03:00",
        stale_hours: 33,
        refs: ["sync:telegram/1001"],
      },
      { source: "MAX", account: "старый аккаунт 394…", reason: "no-schedule", since: null, stale_hours: 0 },
      { source: "MAX", stale_hours: 50, refs: ["account:max/1"] },
      { source: "почта Gmail", stale_hours: 3 },
    ],
    scope: {
      from: "2026-11-05T08:30:00+03:00",
      to: "2026-11-06T08:30:00+03:00",
      sources: [
        { kind: "telegram", accounts: 1 },
        { kind: "max", accounts: 1 },
        { kind: "whatsapp", accounts: 1 },
        { kind: "mail", accounts: 4 },
      ],
      counts: { chats: 31, mail: 12, tasks: 17, meetings: 0 },
    },
    tasks: { overdue: 5, today: 3, tomorrow: 2, new: 4, new_since: "2026-11-05T08:30:00+03:00" },
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
        refs: ["msg:email/anna%40example.com/5005/6006"],
        links: [{ kind: "web", url: "https://attacker.example/", label: "письмо" }],
      },
      {
        type: "question",
        who: "Игорь Лапин",
        topic: "поставка плитки",
        action: "можно ли перенести поставку плитки на 20-е?",
        since: "2026-11-05T19:00:00+03:00",
        channel: "telegram",
        refs: ["chat:telegram/1001/4004"],
      },
      { type: "task", topic: "Акт сверки для «Северного ветра»", due: "2026-11-04", refs: ["task:80"] },
      { type: "task", topic: "Смета «Ремонт офиса»", due: "2026-11-06T18:00:00+03:00", who: "Марина Орлова" },
      { type: "task", topic: "Договор с подрядчиком", who: "Пётр Белов", refs: ["task:81"] },
    ],
  },
  {
    kind: "decisions",
    items: [
      {
        type: "decision",
        topic: "Находки из почты",
        action: "ждут проверки",
        count: 12,
        refs: ["proposal:fact%3A512"],
      },
    ],
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

const viewOf = (text: string, language = "ru", form: LinkForm = "web") => {
  const parsed = parseReport(text)
  if (!parsed || "invalid" in parsed) throw new Error(`not a report: ${JSON.stringify(parsed)}`)
  return reportView(parsed.report, {
    language,
    now: NOW,
    timeZone: ZONE,
    linkOf: (ref) => linkFor(ref, { form, env: {} }),
  })
}

describe("a wirecat.report/1 document", () => {
  it.each(["telegram", "email", "text"] as const)("renders the ru digest for %s", async (channel) => {
    const rendering = await renderReport(viewOf(digest(), "ru", channel === "text" ? "app" : "web"), channel)
    expect(rendering).toMatchObject({ templateFailed: false, templateTags: 0 })
    const extension = channel === "text" ? "txt" : "html"
    await expect(`${rendering.text}\n`).toMatchFileSnapshot(`__snapshots__/morning-digest.ru.${channel}.${extension}`)
    expect(rendering.text).not.toMatch(/msg:|account:|attacker|секрет|owed/)
  })
})

describe("links, task groups, sync health and the footer", () => {
  it("links every slice kind with an https link the grammar accepts, and keeps those hrefs", async () => {
    const { text, templateTags } = await renderReport(viewOf(digest()), "telegram")
    const hrefs = [...text.matchAll(/href="([^"]+)"/g)].map((match) => match[1] as string)
    expect(hrefs.map((href) => parseLink(href)?.type)).toEqual([
      "message",
      "chat",
      "task",
      "task",
      "tasks",
      "tasks",
      "tasks",
      "tasks",
      "proposal",
      "sync",
    ])
    expect(hrefs.every((href) => href.startsWith("https://wirecat.dev/o#/v1/"))).toBe(true)
    expect(templateTags).toBe(0)
  })

  it("writes the group links, the account's sync problem and what was viewed", async () => {
    const { text } = await renderReport(viewOf(digest()), "text")
    expect(text).toContain(
      "Все просроченные (5) https://wirecat.dev/o#/v1/tasks/overdue · на сегодня (3) https://wirecat.dev/o#/v1/tasks/today",
    )
    expect(text).toContain("новые (4) https://wirecat.dev/o#/v1/tasks/new/2026-11-05T08%3A30%3A00%2B03%3A00")
    expect(text).toContain(
      "🛠 Telegram (@ownerdemo): синхронизация падает с 4 ноября · https://wirecat.dev/o#/v1/sync/telegram/1001",
    )
    expect(text).toContain("🛠 MAX (старый аккаунт 394…): нет расписания синхронизации\n🛠 MAX не обновлялся 2 дня")
    expect(text.split("\n").at(-1)).toBe(
      "Просмотрено за 24 ч: Telegram, MAX, WhatsApp, почта (4 ящика) · 31 чат, 12 писем, 17 задач",
    )
  })

  it("shows a task with no due date with no deadline phrase, its person on the first line", async () => {
    const telegram = (await renderReport(viewOf(digest()), "telegram")).text
    expect(telegram).toContain(
      '📌 <b>Договор с подрядчиком</b> — Пётр Белов\n<a href="https://wirecat.dev/o#/v1/task/81">открыть</a>\n',
    )
    const text = (await renderReport(viewOf(digest(), "en"), "text")).text
    expect(text).toContain("📌 Договор с подрядчиком — Пётр Белов\n")
    expect(parseReport(digest([{ kind: "today", items: [{ type: "task", topic: "Без срока" }] }]))).not.toHaveProperty(
      "invalid",
    )
  })

  it("names the window in days, and leaves out zero groups and zero counts", async () => {
    const scope = {
      from: "2026-11-03T08:30:00+03:00",
      to: "2026-11-06T08:30:00+03:00",
      sources: [{ kind: "mail", accounts: 1 }],
      counts: { chats: 0, mail: 1, tasks: 0 },
    }
    const { text } = await renderReport(viewOf(digest(SECTIONS, { scope, tasks: { today: 1, new: 2 } }), "en"), "text")
    expect(text.split("\n").at(-1)).toBe("Viewed over 3 days: mail · 1 email")
    expect(text).toContain("Due today (1) https://wirecat.dev/o#/v1/tasks/today · new (2)\n")
  })

  it("leaves every link out when links are off, and keeps the words", async () => {
    const prepared = await prepareReport(digest(), { ...options, env: { WIRECAT_LINKS: "off" } })
    expect(prepared?.telegram).not.toContain("<a ")
    expect(prepared?.terminal).not.toContain("wirecat://")
    expect(prepared?.text).toContain("Все просроченные (5) · на сегодня (3)")
  })

  it("prepares web links for the routes, app links for the terminal, and the checked document", async () => {
    const prepared = await prepareReport(digest(), { ...options, env: {} })
    expect(prepared?.text).toContain("https://wirecat.dev/o#/v1/task/80")
    expect(prepared?.terminal).toContain("wirecat://open/v1/task/80")
    expect(prepared?.terminal).not.toContain("https://wirecat.dev")
    expect(prepared?.notice).toBe("☀️ Сводка на пятницу, 6 ноября\nТри ответа ждут вас, один платёж просрочен.")
    const document = JSON.parse(prepared?.document ?? "")
    expect(document).not.toHaveProperty("internal")
    expect(document.sections[1].items[0]).not.toHaveProperty("links")
    expect(document.tasks.new_since).toBe("2026-11-05T08:30:00+03:00")
    const again = await prepareReport(JSON.stringify(document), options)
    expect(JSON.parse(again?.document ?? "")).toEqual(document)
  })

  it("still reads a document written before accounts and scope, and refuses a health entry with neither hours nor reason", async () => {
    const old = await prepareReport(
      digest(SECTIONS, { health: [{ source: "MAX", stale_hours: 50 }], scope: undefined, tasks: undefined }),
      options,
    )
    expect(old?.text).toContain("🛠 MAX не обновлялся 2 дня")
    expect(old?.text).not.toContain("Просмотрено")
    const broken = await prepareReport(digest(SECTIONS, { health: [{ source: "MAX" }] }), options)
    expect(broken?.run.invalid).toBe("health[0].stale_hours")
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
      expect(text).not.toMatch(/<a href="https:\/\/evil/)
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
    const prepared = await prepareReport(digest(), { ...options, templates: async () => ({ telegram: "{% if %}" }) })
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
    const quiet = (await prepareReport(digest([]), options))?.text
    expect(quiet).toContain("Новых дел нет, но синхронизация требует внимания.")
    expect(quiet).toContain("🛠 MAX не обновлялся 2 дня")
    const fresh = await prepareReport(digest([], { health: [] }), options)
    expect(fresh?.text).toContain("Тихое утро: ничего срочного.")
  })
})
