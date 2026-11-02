/**
 * Repairs a settings file whose JSON is broken only in its syntax, without AI and without guessing (NEED-2178): a
 * file can hold keys and tokens, so it never leaves the machine. A damage with one reading is fixed; anything else
 * is refused, and the caller changes nothing.
 */

export type RepairKind =
  | "byte_order_mark"
  | "comment"
  | "trailing_comma"
  | "missing_comma"
  | "unquoted_key"
  | "single_quotes"
  | "missing_closer"

/** Where and what, never the text: a value may be a secret. */
export interface RepairFix {
  line: number
  kind: RepairKind
}

export type RepairResult =
  | { state: "valid" }
  | { state: "repaired"; text: string; fixes: RepairFix[] }
  | { state: "refused"; line: number; column: number; why: string }

/** What each fix mends, as a person reads it. */
export const REPAIR_WORDS: Record<RepairKind, string> = {
  byte_order_mark: "an invisible byte-order mark at the start",
  comment: "a comment, which JSON does not allow",
  trailing_comma: "a comma before a closing bracket",
  missing_comma: "a missing comma",
  unquoted_key: "a key without double quotes",
  single_quotes: "text in single quotes",
  missing_closer: "the file stops before its closing brackets — whatever followed this line was already lost",
}

type Node = { object: [string, Node][] } | { array: Node[] } | { json: string }

class GiveUp {
  constructor(
    readonly at: number,
    readonly why: string,
  ) {}
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/
const LITERAL = /^(true|false|null)/
const KEY = /^[A-Za-z_$][\w$.-]*/
const ENDS_VALUE = /^[\s,\]}/]?$/

export const repairConfigText = (text: string): RepairResult => {
  try {
    JSON.parse(text)
    return { state: "valid" }
  } catch {}
  const fixes: RepairFix[] = []
  const lineAt = (offset: number) => text.slice(0, offset).split("\n").length
  const fix = (kind: RepairKind, offset: number) => fixes.push({ kind, line: lineAt(offset) })
  const giveUp = (why: string, offset = at): never => {
    throw new GiveUp(offset, why)
  }

  let at = 0
  let truncated = false
  let last: "open" | "comma" | "value" | "close" = "open"
  let lastEnd = 0
  // A nested value() moves it, which TypeScript's narrowing inside the loop cannot see.
  const previous = () => last

  const skip = () => {
    for (;;) {
      while (/\s/.test(text[at] ?? "")) at++
      if (text.startsWith("//", at)) {
        fix("comment", at)
        while (at < text.length && text[at] !== "\n") at++
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2)
        if (end < 0) giveUp("a /* comment is never closed")
        fix("comment", at)
        at = end + 2
      } else return
    }
  }

  const string = (): string => {
    const quote = text[at] as string
    const start = at
    if (quote === "'") fix("single_quotes", at)
    at++
    let body = ""
    for (;;) {
      if (at >= text.length) giveUp("the file stops inside a quoted text", start)
      const char = text[at] as string
      if (char === quote) break
      if (text.charCodeAt(at) < 0x20) giveUp("a line break inside a quoted text")
      if (char === "\\") {
        const next = text[at + 1] ?? ""
        if (quote === "'" && next === "'") body += "'"
        else if (/^["\\/bfnrt]$/.test(next)) body += `\\${next}`
        else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
          body += text.slice(at, at + 6)
          at += 4
        } else giveUp("an escape JSON has no meaning for")
        at += 2
        continue
      }
      body += char === '"' ? '\\"' : char
      at++
    }
    at++
    return JSON.parse(`"${body}"`) as string
  }

  const key = (): string => {
    const char = text[at] ?? ""
    if (char === '"' || char === "'") return string()
    const word = KEY.exec(text.slice(at))?.[0]
    if (!word) return giveUp("something other than a key where a key should be")
    fix("unquoted_key", at)
    at += word.length
    return word
  }

  const scalar = (): Node => {
    const char = text[at] ?? ""
    if (char === '"' || char === "'") return { json: JSON.stringify(string()) }
    const word = (NUMBER.exec(text.slice(at)) ?? LITERAL.exec(text.slice(at)))?.[0]
    if (!word || !ENDS_VALUE.test(text[at + word.length] ?? ""))
      return giveUp("a value that is not JSON — text needs quotes, and only true, false and null go without")
    // A number the file stops on may be the start of a longer one.
    if (at + word.length === text.length && NUMBER.test(word)) giveUp("the file stops inside a number")
    at += word.length
    return { json: word }
  }

  /** Members of an object or items of a list, with every syntax fix that has one reading. */
  const members = <T>(close: "}" | "]", one: () => T): T[] => {
    const out: T[] = []
    at++
    last = "open"
    let comma = -1
    for (;;) {
      skip()
      if (truncated) return out
      if (at >= text.length) {
        if (previous() === "close")
          giveUp("the file stops after a closing bracket, so which brackets are missing has two readings")
        if (previous() === "comma") fix("trailing_comma", comma)
        fix("missing_closer", text.length)
        truncated = true
        return out
      }
      const char = text[at]
      if (char === close) {
        if (previous() === "comma") fix("trailing_comma", comma)
        at++
        last = "close"
        return out
      }
      if (char === "}" || char === "]") giveUp(`a ${char} where ${close} should close`)
      if (char === ",") {
        if (previous() !== "value" && previous() !== "close") giveUp("a comma with nothing before it")
        comma = at
        at++
        last = "comma"
        continue
      }
      if (previous() === "value" || previous() === "close") {
        if (lineAt(at) === lineAt(lastEnd)) giveUp("two entries on one line with no comma between them")
        fix("missing_comma", lastEnd)
      }
      out.push(one())
    }
  }

  const value = (): Node => {
    const char = text[at] ?? ""
    let node: Node
    if (char === "{") {
      const seen = new Set<string>()
      node = {
        object: members("}", () => {
          const start = at
          const name = key()
          // JSON.parse keeps the last of two, which could lift a deny written first.
          if (seen.has(name)) giveUp("a key appears twice in one object", start)
          seen.add(name)
          skip()
          if (at >= text.length) giveUp("the file stops after a key, before its value")
          if (text[at] !== ":") giveUp("a key with no colon after it")
          at++
          skip()
          if (at >= text.length) giveUp("the file stops after a key, before its value")
          return [name, value()] as [string, Node]
        }),
      }
    } else if (char === "[") {
      node = {
        array: members("]", () => {
          return value()
        }),
      }
    } else node = scalar()
    if (!truncated) {
      last = "json" in node ? "value" : "close"
      lastEnd = at
    }
    return node
  }

  try {
    if (text.includes("\u0000") || text.includes(String.fromCharCode(0xfffd))) giveUp("the file is not text", 0)
    if (text.charCodeAt(0) === 0xfeff) {
      fix("byte_order_mark", 0)
      at = 1
    }
    skip()
    if (text[at] !== "{") giveUp(at >= text.length ? "the file is empty" : "the file does not start with {")
    const root = value()
    skip()
    if (at < text.length) giveUp("more text after the closing }")
    const repaired = `${serialise(root, "")}\n`
    JSON.parse(repaired)
    return { state: "repaired", text: repaired, fixes }
  } catch (error) {
    if (!(error instanceof GiveUp)) throw error
    const before = text.slice(0, error.at).split("\n")
    return {
      state: "refused",
      line: before.length,
      column: (before.at(-1)?.length ?? 0) + 1,
      why: error.why,
    }
  }
}

/** `JSON.stringify(value, null, 2)` as `saveConfigFile` writes it, but in the file's own key order and numbers. */
const serialise = (node: Node, indent: string): string => {
  if ("json" in node) return node.json
  const inner = `${indent}  `
  const parts =
    "object" in node
      ? node.object.map(([name, item]) => `${inner}${JSON.stringify(name)}: ${serialise(item, inner)}`)
      : node.array.map((item) => `${inner}${serialise(item, inner)}`)
  const [open, close] = "object" in node ? ["{", "}"] : ["[", "]"]
  return parts.length === 0 ? `${open}${close}` : `${open}\n${parts.join(",\n")}\n${indent}${close}`
}
