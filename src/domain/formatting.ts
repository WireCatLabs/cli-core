import { CliError, visibleControls } from "@wirecat/cli-base"

export interface TextSpan {
  type:
    | "bold"
    | "italic"
    | "strike"
    | "underline"
    | "code"
    | "pre"
    | "link"
    | "blockquote"
    | "spoiler"
    | "highlight"
    | "heading"
  from: number
  length: number
  url?: string
  language?: string
}

export interface FormattedText {
  text: string
  spans: TextSpan[]
}

export interface MarkdownFormatting {
  formatMarkdown(text: string): Promise<FormattedText>
}

export interface HtmlFormatting {
  formatHtml(text: string): Promise<FormattedText>
}

const invalid = () => new CliError("validation_error", "the messenger formatter returned invalid text spans")

export const validateFormattedText = (formatted: FormattedText): FormattedText => {
  const { text, spans } = formatted
  if (typeof text !== "string" || !Array.isArray(spans) || spans.length > 100) throw invalid()
  const boundary = (at: number) =>
    !(
      at > 0 &&
      at < text.length &&
      /[\uD800-\uDBFF]/u.test(text[at - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(text[at] ?? "")
    )
  for (const span of spans) {
    if (
      ![
        "bold",
        "italic",
        "strike",
        "underline",
        "code",
        "pre",
        "link",
        "blockquote",
        "spoiler",
        "highlight",
        "heading",
      ].includes(span.type) ||
      !Number.isInteger(span.from) ||
      !Number.isInteger(span.length) ||
      span.from < 0 ||
      span.length <= 0 ||
      span.from + span.length > text.length ||
      !boundary(span.from) ||
      !boundary(span.from + span.length)
    )
      throw invalid()
    if (span.type === "link") {
      if (!span.url || Array.from(span.url).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
        throw new CliError("validation_error", "a Markdown link needs an absolute http, https or mailto URL")
      let url: URL
      try {
        url = new URL(span.url)
      } catch {
        throw new CliError("validation_error", "a Markdown link needs an absolute http, https or mailto URL")
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol))
        throw new CliError("validation_error", "Markdown links support http, https and mailto URLs")
    }
  }
  return formatted
}

export const visibleFormattedText = (formatted: FormattedText): FormattedText => {
  validateFormattedText(formatted)
  const text = visibleControls(formatted.text)
  const positions = new Map<number, number>([[0, 0]])
  let original = 0
  let visible = 0
  for (const character of formatted.text) {
    const rendered = text.startsWith(character, visible) ? character : visibleControls(character)
    original += character.length
    visible += rendered.length
    positions.set(original, visible)
  }
  return {
    text,
    spans: formatted.spans.map((span) => ({
      ...span,
      from: positions.get(span.from) as number,
      length: (positions.get(span.from + span.length) as number) - (positions.get(span.from) as number),
      ...(span.url === undefined ? {} : { url: visibleControls(span.url) }),
    })),
  }
}
