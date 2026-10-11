const GREETING =
  /^(hi|hello|hey|dear|greetings|good (morning|afternoon|evening)|привет|здравствуй(те)?|добр(ый|ое|ого) (день|вечер|утро|утра|дня)|hola|buen(os|as) (días|dias|tardes|noches)|estimad[oa]s?|querid[oa]s?)(?![\p{L}\p{N}])[^\n]{0,40}$/iu

const SIGN_OFF =
  /^(best|best regards|best wishes|kind regards|warm regards|regards|thanks|thanks again|thanks a lot|thank you|many thanks|cheers|sincerely|yours|yours truly|yours sincerely|br|с уважением|спасибо|заранее спасибо|всего доброго|всего хорошего|un saludo|saludos|saludos cordiales|atentamente|gracias|muchas gracias)[\s,.!]*$/iu

const ATTRIBUTION = /(wrote|написал[аи]?|escribió|a écrit|schrieb)\s*:\s*$/iu
const OUTLOOK = /^(-{2,}\s*original message\s*-{2,}|-{2,}\s*исходное сообщение\s*-{2,}|from:\s.+)$/iu
const SENT_FROM = /^(sent from my |отправлено с |enviado desde mi )/iu

const unquoted = (line: string) => line.replace(/^(\s*>)+\s?/, "")
const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()
const flat = (text: string) => squash(text.split("\n").map(unquoted).join("\n"))

/** At least four fifths of the quote's text appears in an earlier email: a re-quote, not new content. */
const alreadyHeld = (quote: string[], earlier: string[]): boolean => {
  const lines = quote.map((line) => squash(unquoted(line))).filter((line) => line.length > 0)
  const total = lines.reduce((sum, line) => sum + line.length, 0)
  if (total === 0) return true
  const found = lines.filter((line) => earlier.some((text) => text.includes(line)))
  return found.reduce((sum, line) => sum + line.length, 0) >= total * 0.8
}

interface QuoteBlock {
  /** The lines dropped when the quote is held: the attribution or header with the quote. */
  start: number
  end: number
  /** The quoted text alone, compared with earlier emails. */
  quoted: string[]
}

const quoteBlocks = (lines: string[]): QuoteBlock[] => {
  const blocks: QuoteBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (
      OUTLOOK.test(line.trim()) &&
      (line.trim().startsWith("-") || /^sent:|^date:|^отправлено:/iu.test(lines[i + 1] ?? ""))
    ) {
      const body = lines.findIndex((text, at) => at > i && !text.trim())
      blocks.push({ start: i, end: lines.length, quoted: lines.slice(body === -1 ? i + 1 : body) })
      break
    }
    if (!/^\s*>/.test(line)) continue
    let end = i
    while (end < lines.length && (/^\s*>/.test(lines[end] ?? "") || !(lines[end] ?? "").trim())) end++
    let start = i
    for (let back = i - 1; back >= 0 && back >= i - 3; back--) {
      const prior = lines[back] ?? ""
      if (!prior.trim()) continue
      if (ATTRIBUTION.test(prior)) start = /^on\s/i.test(lines[back - 1] ?? "") ? back - 1 : back
      break
    }
    blocks.push({ start, end, quoted: lines.slice(i, end) })
    i = end - 1
  }
  return blocks
}

const trimEdges = (lines: string[]): string[] => {
  let first = 0
  while (first < lines.length && !(lines[first] ?? "").trim()) first++
  let last = lines.length
  while (last > first && !(lines[last - 1] ?? "").trim()) last--
  return lines.slice(first, last)
}

const withoutGreeting = (lines: string[]): string[] =>
  lines.length > 1 && GREETING.test((lines[0] ?? "").trim()) ? trimEdges(lines.slice(1)) : lines

const withoutSignOff = (lines: string[]): string[] => {
  const separator = lines.findIndex((line) => line === "-- " || line === "--")
  let kept = separator > 0 ? trimEdges(lines.slice(0, separator)) : lines
  kept = kept.filter((line) => !SENT_FROM.test(line.trim()))
  for (let i = kept.length - 1; i >= Math.max(1, kept.length - 6); i--) {
    const tail = kept.slice(i + 1)
    if (tail.length > 4 || tail.some((line) => line.trim().length > 50)) break
    if (SIGN_OFF.test((kept[i] ?? "").trim())) return trimEdges(kept.slice(0, i))
  }
  return kept
}

/**
 * What an email adds to its thread, for search by meaning: its body without the greeting, the sign-off and
 * signature, and without any quoted block whose text is in an earlier email of the thread. A quote of mail we do
 * not hold stays, so a forward or a reply to an unsaved email is still found.
 */
export const mailCore = (body: string, earlier: string[]): string => {
  const lines = body.replace(/\r\n?/g, "\n").split("\n")
  const held = earlier.map(flat)
  const drop = new Set<number>()
  for (const { start, end, quoted } of quoteBlocks(lines))
    if (alreadyHeld(quoted, held)) for (let i = start; i < end; i++) drop.add(i)
  const kept = trimEdges(lines.filter((_, i) => !drop.has(i)))
  return withoutSignOff(withoutGreeting(kept)).join("\n").trim()
}
