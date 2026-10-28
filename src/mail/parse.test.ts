import { expect, it } from "vitest"
import { parseMail } from "./parse.js"

const raw = (...lines: string[]) => new TextEncoder().encode(lines.join("\r\n"))

it("keeps To and Cc apart", async () => {
  const parsed = await parseMail(
    raw(
      'To: "Bob Sample" <Bob@Example.com>',
      'Cc: "Kai Sample" <kai@example.com>',
      "Subject: Synthetic",
      "",
      "Synthetic body",
    ),
  )
  expect(parsed.to).toEqual([{ email: "bob@example.com", name: "Bob Sample" }])
  expect(parsed.cc).toEqual([{ email: "kai@example.com", name: "Kai Sample" }])
  expect(parsed).toMatchObject({ subject: "Synthetic", from: null, bcc: [], text: "Synthetic body" })
})

it("reads the people of an address group, and a missing name as null", async () => {
  const parsed = await parseMail(raw("To: Team: alice@example.test, Bob Sample <bob@example.test>;", "", "x"))
  expect(parsed.to).toEqual([
    { email: "alice@example.test", name: null },
    { email: "bob@example.test", name: "Bob Sample" },
  ])
})

it("turns an HTML-only mail into text and keeps attachment bytes", async () => {
  const parsed = await parseMail(
    raw(
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/html",
      "",
      "<p>Hello&nbsp;there</p>",
      "--b",
      'Content-Type: text/csv; name="budget.csv"',
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("a,b\n1,2\n").toString("base64"),
      "--b--",
    ),
  )
  expect(parsed.text).toBe("Hello there")
  expect(parsed.attachments).toMatchObject([{ id: 0, name: "budget.csv", mime: "text/csv" }])
  expect(new TextDecoder().decode(parsed.attachments[0]?.bytes ?? undefined)).toBe("a,b\n1,2\n")
})

const htmlMail = (html: string) => raw("Content-Type: text/html; charset=utf-8", "", html)

it("turns HTML into text: no scripts or styles, lines at blocks, entities decoded once", async () => {
  const parsed = await parseMail(
    htmlMail(
      "<style>p{}</style><SCRIPT>x()</script><p>One &amp; two</p><div>a&nbsp;&quot;b&quot; &#39;c&#39;</div>  \n" +
        "<br/>Write &amp;lt;tag&amp;gt; for &lt;tag&gt;</li>end",
    ),
  )
  expect(parsed.text).toBe("One & two\na \"b\" 'c'\n\nWrite &lt;tag&gt; for <tag>\nend")
})

it.each([
  ["<", "<".repeat(200_000)],
  ["<a", "<a".repeat(100_000)],
  ["<script", "<script".repeat(30_000)],
  ["<style>", `<style>${"<script>".repeat(25_000)}`],
  ["spaces", `${" \t".repeat(100_000)}x`],
])("strips %s repeated to 200k characters of HTML in linear time", async (_name, hostile) => {
  // Each of these took seconds at this size when a regex rescanned to the end from every `<`.
  const started = performance.now()
  await parseMail(htmlMail(hostile))
  expect(performance.now() - started).toBeLessThan(2_000)
})
