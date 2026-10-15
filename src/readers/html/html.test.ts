import { describe, expect, it, vi } from "vitest"
import { extractText, importEngine, type LoadEngine } from "../../attachments/extract.js"

const hint = (name: string) => ({ kind: "file", name, mime: "text/html", path: `/saved/${name}` })
const read = (html: string, load: LoadEngine = importEngine) =>
  extractText(new TextEncoder().encode(html), hint("page.html"), load)

const ARTICLE = `<!doctype html><html lang="en"><head>
<title>Quarterly report | Acme News</title>
<meta name="description" content="How the quarter went">
<meta name="keywords" content="finance, Q3 ,report">
<meta property="og:site_name" content="Acme News"><meta property="og:type" content="article">
<link rel="canonical" href="https://acme.example/q3">
<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Dana Reyes"},"datePublished":"2026-10-01"}</script>
</head><body>
<nav><a href="/">Home</a> <a href="/about">About us</a></nav>
<div class="cookie-banner">We use cookies. Accept all</div>
<article><h1>Quarterly report</h1>
<p>Revenue grew by twelve percent over the previous quarter, driven by the new subscription plans and renewals.</p>
<h2>Costs</h2><ul><li>Hosting</li><li>Support</li></ul>
<table><tr><th>Item</th><th>Amount</th></tr><tr><td>Hosting</td><td>40</td></tr></table>
<p>Costs stayed flat while the team grew, which is the second quarter in a row that this happened.</p>
<img src="chart.png" alt="Revenue chart"></article>
<footer>Copyright Acme, all rights reserved</footer></body></html>`

describe("the HTML reader", () => {
  it("keeps the main text as Markdown and drops the page furniture", async () => {
    const result = await read(ARTICLE)
    expect(result).toMatchObject({ status: "extracted", extractor: "html:v2" })
    if (result.status !== "extracted") return
    expect(result.text).toContain("Revenue grew by twelve percent")
    expect(result.text).toContain("## Costs")
    expect(result.text).toContain("- Hosting")
    expect(result.text).toContain("| Item | Amount |")
    expect(result.text).toContain("Revenue chart")
    expect(result.text).not.toMatch(/cookies|About us|Copyright/)
  })

  it("captures the metadata, with the author from JSON-LD and the language from <html>", async () => {
    const result = await read(ARTICLE)
    if (result.status !== "extracted") throw new Error("not extracted")
    expect(result.metadata).toMatchObject({
      title: "Quarterly report",
      description: "How the quarter went",
      author: "Dana Reyes",
      published: "2026-10-01",
      language: "en",
      site: "Acme News",
      canonical: "https://acme.example/q3",
      keywords: ["finance", "Q3", "report"],
      "og:type": "article",
      jsonLdType: ["NewsArticle"],
    })
  })

  it("gives one section per heading, as ranges of the text", async () => {
    const result = await read(ARTICLE)
    if (result.status !== "extracted") throw new Error("not extracted")
    const costs = result.sections?.find(({ heading }) => heading === "Costs")
    expect(costs).toMatchObject({ level: 2 })
    expect(result.text.slice(costs?.start, costs?.end)).toMatch(/^## Costs[\s\S]*second quarter in a row/)
    expect(result.sections?.at(-1)?.end).toBe(result.text.length)
  })

  it("reads a Russian page", async () => {
    const result = await read(`<html lang="ru"><head><title>Отчёт — Новости</title>
      <meta name="author" content="Иван Петров"></head><body><nav>Главная</nav><article>
      <h1>Отчёт за квартал</h1><p>Выручка выросла на двенадцать процентов по сравнению с прошлым кварталом благодаря новым тарифам.</p>
      <h2>Расходы</h2><p>Расходы остались прежними, хотя команда выросла, и это уже второй квартал подряд.</p></article>
      <footer>Все права защищены</footer></body></html>`)
    if (result.status !== "extracted") throw new Error("not extracted")
    expect(result.text).toContain("Выручка выросла")
    expect(result.text).not.toContain("Все права защищены")
    expect(result.metadata).toMatchObject({ language: "ru", author: "Иван Петров" })
    expect(result.sections?.map(({ heading }) => heading)).toContain("Расходы")
  })

  it("never goes online, even for an empty single-page app shell", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in a reader"))
    try {
      await read(
        `<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>`,
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it("falls back to the plain reader, html:v1, when the engine will not load", async () => {
    const broken: LoadEngine = async (name) => {
      if (name === "defuddle/node") throw new Error("boom")
      return importEngine(name)
    }
    const result = await read(ARTICLE, broken)
    expect(result).toMatchObject({
      status: "extracted",
      extractor: "html:v1",
      metadata: { title: "Quarterly report | Acme News" },
    })
    if (result.status === "extracted") expect(result.text).toContain("Revenue grew")
  })

  it("reads a hostile page of unclosed tags in linear time when the engine will not load", async () => {
    const broken: LoadEngine = async (name) => {
      if (name === "defuddle/node") throw new Error("boom")
      return importEngine(name)
    }
    // The plain reader and its title lookup once rescanned to the end from every `<`: seconds at this size.
    const hostile = `<title>${"<title".repeat(20_000)}${"<p".repeat(50_000)}${"<!--".repeat(25_000)}${"<".repeat(100_000)}`
    const started = performance.now()
    const result = await read(hostile, broken)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({ status: "extracted", extractor: "html:v1" })
  })
})
