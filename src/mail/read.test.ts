import { describe, expect, it } from "vitest"
import { ATTACHMENT_CHARS, lowerSuspicious, withAttachmentText } from "./read.js"

const hit = (names: string[], mimes: string[] = []) =>
  ({
    id: "m1",
    locator: "msg:email/alice@example.com/t1/m1",
    attachments: names.map((name, at) => ({ kind: "file", name, mime: mimes[at] ?? "application/pdf" })),
  }) as unknown as Parameters<typeof withAttachmentText>[0]

const file = (text: string | null, extractionError: string | null = null) => ({
  text,
  extraction: text ? "text" : "failed",
  extractionError,
})

describe("messages show attachment text", () => {
  it("puts each attachment's extracted text next to its name", () => {
    const shown = withAttachmentText(hit(["bill.pdf"]), [file("Total 85,93 €\nPay by 5 Oct")], false)
    expect(shown.attachments).toEqual([
      { kind: "file", name: "bill.pdf", mime: "application/pdf", text: "Total 85,93 €\nPay by 5 Oct", text_chars: 26 },
    ])
  })

  it("cuts long text unless the whole of it is asked for", () => {
    const long = "x".repeat(ATTACHMENT_CHARS + 10)
    const [cut] = withAttachmentText(hit(["scan.pdf"]), [file(long)], false).attachments ?? []
    expect(cut).toMatchObject({ text_chars: ATTACHMENT_CHARS + 10, text_cut: true })
    expect((cut as unknown as { text: string }).text).toHaveLength(ATTACHMENT_CHARS)
    const [whole] = withAttachmentText(hit(["scan.pdf"]), [file(long)], true).attachments ?? []
    expect((whole as unknown as { text: string }).text).toHaveLength(ATTACHMENT_CHARS + 10)
  })

  it("says why a file has no text", () => {
    const [scan] = withAttachmentText(hit(["photo.pdf"]), [file(null, "needs-agent")], false).attachments ?? []
    expect(scan).toEqual({ kind: "file", name: "photo.pdf", mime: "application/pdf", extraction: "needs-agent" })
  })

  it("leaves out the HTML and AMP versions of the body unless --full is given", () => {
    const email = hit(["attachment-0", "attachment-1", "bill.pdf"], ["text/x-amp-html", "text/html", "application/pdf"])
    const files = [file("<html amp4email>…</html>"), file("<html>…</html>"), file("Total 85,93 €")]

    expect(withAttachmentText(email, files, false).attachments?.map(({ name }) => name)).toEqual(["bill.pdf"])
    expect(withAttachmentText(email, files, true).attachments?.map(({ name }) => name)).toEqual([
      "attachment-0",
      "attachment-1",
      "bill.pdf",
    ])
  })
})

it("moves suspicious items after the rest and keeps each part in its order", () => {
  const items = ["a", "fake1", "b", "fake2", "c"]
  expect(lowerSuspicious(items, (item) => item.startsWith("fake"))).toEqual(["a", "b", "c", "fake1", "fake2"])
})
