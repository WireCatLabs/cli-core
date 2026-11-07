const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const SLOT = "\u0000"

/** Inline Markdown to the tags Telegram's HTML accepts; code and links are set aside first so nothing inside them is touched. */
const inline = (text: string): string => {
  const kept: string[] = []
  const keep = (html: string) => `${SLOT}${kept.push(html) - 1}${SLOT}`
  const done = esc(text.replaceAll(SLOT, ""))
    .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g, (_, label: string, url: string) =>
      keep(`<a href="${url}">${label}</a>`),
    )
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_, a?: string, b?: string) => `<b>${a ?? b}</b>`)
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<!\w)_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!\w)/g, "<i>$1</i>")
  return done.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_, at: string) => kept[Number(at)] ?? "")
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())

const isRule = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row)

/** A table has no Telegram form: each row becomes a bullet, its first cell the label and the rest `header: value`. */
const tableLines = (rows: string[]): string[] => {
  const [head = [], ...body] = rows.filter((row) => !isRule(row)).map(cells)
  return body.map(([first = "", ...rest]) => {
    const parts = rest.map((cell, at) => {
      const name = head[at + 1]
      return name && rest.length > 1 ? `${name}: ${inline(cell)}` : inline(cell)
    })
    return `• ${parts.length ? `<b>${inline(first)}</b>: ${parts.join(" · ")}` : inline(first)}`
  })
}

/** The report's common Markdown as Telegram HTML (<b>, <i>, <a>, <code>, <pre>); everything else is escaped text. */
export const toTelegramHtml = (markdown: string): string => {
  const out: string[] = []
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ""
    if (/^\s*```/.test(line)) {
      const code: string[] = []
      at += 1
      while (at < lines.length && !/^\s*```/.test(lines[at] ?? "")) code.push(lines[at++] ?? "")
      out.push(`<pre>${esc(code.join("\n"))}</pre>`)
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [line]
      while (/^\s*\|.*\|\s*$/.test(lines[at + 1] ?? "")) {
        at += 1
        rows.push(lines[at] ?? "")
      }
      for (const row of tableLines(rows)) out.push(row)
    } else if (/^#{1,6}\s+\S/.test(line)) {
      out.push(`<b>${inline(line.replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "")).trimEnd()}</b>`)
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────")
    } else {
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
      out.push(bullet ? `${bullet[1]}• ${inline(bullet[2] ?? "")}` : inline(line))
    }
  }
  return out.join("\n")
}
