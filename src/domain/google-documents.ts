/** A Google Docs, Sheets, Slides, Forms or Drive link as written in a message, and the file id it carries. */
export interface GoogleDocumentLink {
  url: string
  /** `null` when the URL names no file: a Drive folder or page, a shortened link. */
  documentId: string | null
}

const LINK = /https?:\/\/(?:(?:docs|drive|sheets|slides)\.google\.com|forms\.gle)(?:[/?#][^\s<>"'`]*)?/gi
const ID = /^[\w-]{10,}$/

/** A URL as written, without the sentence's punctuation after it; closing brackets stay when the URL opened them. */
export const trimUrl = (url: string): string => {
  let end = url.length
  for (;;) {
    const last = url[end - 1]
    if (last === undefined) break
    if (".,;:!?".includes(last)) end -= 1
    else if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "["
      const head = url.slice(0, end)
      if (head.split(open).length >= head.split(last).length) break
      end -= 1
    } else break
  }
  return url.slice(0, end)
}

/** The Google file id a Docs, Sheets, Slides, Forms or Drive URL carries; `null` for any other URL. */
export const googleDocumentId = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!/^(?:docs|drive|sheets|slides)\.google\.com$/.test(parsed.hostname.toLowerCase())) return null
  const segments = parsed.pathname.split("/")
  const at = segments.indexOf("d")
  const candidate = at < 0 ? parsed.searchParams.get("id") : segments[segments[at + 1] === "e" ? at + 2 : at + 1]
  return candidate && ID.test(candidate) ? candidate : null
}

/** Every Google document link in the text, in order; the reader and drive's link writer both use it. */
export const googleDocumentLinks = (text: string): GoogleDocumentLink[] =>
  [...text.matchAll(LINK)].map(([match]) => {
    const url = trimUrl(match)
    return { url, documentId: googleDocumentId(url) }
  })
