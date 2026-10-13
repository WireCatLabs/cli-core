// Grammar port: Lucene 9.12.3 util/automaton/RegExp.java (Apache-2.0); see scripts/search-reference notices.

import type { Span } from "@wirecat/cli-base/query"
import { fold } from "../../store/normalize.js"
import { exhausted, QUERY_LIMITS, searchError } from "./types.js"

type Atom = { kind: "char"; ranges: [number, number][]; negate: boolean } | { kind: "empty" } | { kind: "epsilon" }
type Expression =
  | Atom
  | { kind: "concat"; children: Expression[] }
  | { kind: "union"; children: Expression[] }
  | { kind: "repeat"; child: Expression; min: number; max: number | null }
interface State {
  epsilon: number[]
  edges: { to: number; atom: Extract<Atom, { kind: "char" }> }[]
}
export interface MatchBudget {
  work: number
  maxWork?: number
}
export interface Automaton {
  states: number
  test(text: string, budget?: MatchBudget): boolean
}
const any: Atom = { kind: "char", ranges: [[0, 0x10ffff]], negate: false }
const literal = (c: string): Atom => ({
  kind: "char",
  ranges: [[c.codePointAt(0) ?? 0, c.codePointAt(0) ?? 0]],
  negate: false,
})

export const compileAutomaton = (pattern: string, span: Span = { start: 0, end: pattern.length }): Automaton => {
  if (pattern.length > QUERY_LIMITS.pattern * 2) exhausted("pattern")
  const chars = [...pattern]
  if (chars.length > QUERY_LIMITS.pattern) exhausted("pattern")
  let at = 0,
    depth = 0
  const failure = () => searchError("query.invalid-regex", span, "use the supported Lucene regex subset")
  const character = (): string => {
    if (at >= chars.length) return failure()
    return chars[at++] as string
  }
  const predefined = (): Atom | undefined => {
    if (chars[at] !== "\\") return undefined
    const name = chars[at + 1] ?? ""
    let ranges: [number, number][] | undefined
    if (name.toLowerCase() === "d") ranges = [[48, 57]]
    if (name.toLowerCase() === "w")
      ranges = [
        [48, 57],
        [65, 90],
        [95, 95],
        [97, 122],
      ]
    if (name.toLowerCase() === "s")
      ranges = [
        [9, 10],
        [13, 13],
        [32, 32],
      ]
    if (ranges) {
      at += 2
      return { kind: "char", ranges, negate: name === name.toUpperCase() }
    }
    if (/^[a-zA-Z]$/u.test(name)) return failure()
    return undefined
  }
  const escaped = () => {
    if (chars[at] === "\\") at++
    return character()
  }
  const union = (): Expression => {
    if (++depth > QUERY_LIMITS.depth) exhausted("pattern depth")
    const children = [concat()]
    while (chars[at] === "|") {
      at++
      children.push(concat())
    }
    depth--
    return children.length === 1 ? (children[0] as Expression) : { kind: "union", children }
  }
  const concat = (): Expression => {
    const children: Expression[] = []
    do {
      children.push(repeat())
    } while (at < chars.length && ![")", "|", "&"].includes(chars[at] ?? ""))
    if (chars[at] === "&") searchError("query.unsupported-regex", span, "automaton intersection is not supported")
    return children.length === 1 ? (children[0] as Expression) : { kind: "concat", children }
  }
  const repeat = (): Expression => {
    let child = simple()
    while (["?", "*", "+", "{"].includes(chars[at] ?? "")) {
      const op = character()
      let min = op === "+" ? 1 : 0,
        max: number | null = op === "?" ? 1 : null
      if (op === "{") {
        const number = () => {
          const start = at
          while (/^[0-9]$/u.test(chars[at] ?? "")) at++
          if (at === start) return failure()
          return Number(chars.slice(start, at).join(""))
        }
        min = number()
        max = min
        if (chars[at] === ",") {
          at++
          max = chars[at] === "}" ? null : number()
        }
        if (character() !== "}" || (max !== null && max < min)) return failure()
      }
      if (min > QUERY_LIMITS.states || (max !== null && max > QUERY_LIMITS.states)) exhausted("automaton states")
      child = { kind: "repeat", child, min, max }
    }
    return child
  }
  const simple = (): Expression => {
    const predefinedAtom = predefined()
    if (predefinedAtom) return predefinedAtom
    const c = character()
    if (c === "~" || c === "<")
      searchError("query.unsupported-regex", span, "complement, named automata and numeric intervals are not supported")
    if (c === ".") return any
    if (c === "#") return { kind: "empty" }
    if (c === "@") return { kind: "repeat", child: any, min: 0, max: null }
    if (c === '"') {
      const children: Expression[] = []
      while (chars[at] !== '"') children.push(literal(character()))
      at++
      return { kind: "concat", children }
    }
    if (c === "(") {
      if (chars[at] === ")") {
        at++
        return { kind: "epsilon" }
      }
      if (chars[at] === "?")
        searchError("query.unsupported-regex", span, "JavaScript groups and lookaround are not Lucene operators")
      const child = union()
      if (character() !== ")") return failure()
      return child
    }
    if (c === "[") {
      const negate = chars[at] === "^"
      if (negate) at++
      const choices: Expression[] = []
      do {
        const pre = predefined()
        if (pre) {
          choices.push(pre)
          continue
        }
        const lo = escaped().codePointAt(0) ?? 0
        let hi = lo
        if (chars[at] === "-") {
          at++
          hi = escaped().codePointAt(0) ?? 0
        }
        if (hi < lo) return failure()
        choices.push({ kind: "char", ranges: [[lo, hi]], negate: false })
      } while (at < chars.length && chars[at] !== "]")
      if (character() !== "]") return failure()
      if (!negate) return { kind: "union", children: choices }
      const ranges: [number, number][] = []
      for (const choice of choices) {
        if (choice.kind !== "char" || choice.negate)
          searchError(
            "query.unsupported-regex",
            span,
            "negative predefined classes inside a negated class are not supported",
          )
        ranges.push(...choice.ranges)
      }
      return { kind: "char", ranges, negate: true }
    }
    if (c === "\\") return literal(character())
    return literal(c)
  }
  const expression: Expression = chars.length === 0 ? { kind: "epsilon" } : union()
  if (at !== chars.length) return failure()
  const states: State[] = []
  const state = () => {
    if (states.length >= QUERY_LIMITS.states) exhausted("automaton states")
    states.push({ epsilon: [], edges: [] })
    return states.length - 1
  }
  const epsilon = (from: number, to: number) => {
    ;(states[from] as State).epsilon.push(to)
  }
  const build = (node: Expression, from: number, to: number): void => {
    if (node.kind === "char") {
      ;(states[from] as State).edges.push({ to, atom: node })
      return
    }
    if (node.kind === "empty") return
    if (node.kind === "epsilon") {
      epsilon(from, to)
      return
    }
    if (node.kind === "union") {
      for (const child of node.children) build(child, from, to)
      return
    }
    if (node.kind === "concat") {
      let current = from
      node.children.forEach((child, index) => {
        const next = index === node.children.length - 1 ? to : state()
        build(child, current, next)
        current = next
      })
      if (node.children.length === 0) epsilon(from, to)
      return
    }
    let current = from
    for (let i = 0; i < node.min; i++) {
      const next = state()
      build(node.child, current, next)
      current = next
    }
    if (node.max === null) {
      epsilon(current, to)
      const end = state()
      build(node.child, current, end)
      epsilon(end, current)
    } else {
      for (let i = node.min; i < node.max; i++) {
        epsilon(current, to)
        const next = state()
        build(node.child, current, next)
        current = next
      }
      epsilon(current, to)
    }
  }
  const start = state(),
    end = state()
  build(expression, start, end)
  return {
    states: states.length,
    test: (text, budget = { work: 0 }) => {
      const spend = () => {
        if (++budget.work > (budget.maxWork ?? QUERY_LIMITS.work)) exhausted("automaton work")
      }
      const closure = (initial: Set<number>) => {
        const stack = [...initial]
        while (stack.length) {
          const id = stack.pop() as number
          for (const next of (states[id] as State).epsilon) {
            spend()
            if (!initial.has(next)) {
              initial.add(next)
              stack.push(next)
            }
          }
        }
        return initial
      }
      let current = closure(new Set([start]))
      for (const c of text) {
        const point = c.codePointAt(0) ?? 0
        const next = new Set<number>()
        for (const id of current)
          for (const edge of (states[id] as State).edges) {
            spend()
            const inside = edge.atom.ranges.some(([lo, hi]) => point >= lo && point <= hi)
            if (inside !== edge.atom.negate) next.add(edge.to)
          }
        current = closure(next)
        if (current.size === 0) return false
      }
      return current.has(end)
    },
  }
}

export const wildcardPattern = (value: string): string => {
  const chars = [...value]
  let pattern = ""
  for (let at = 0; at < chars.length; at++) {
    const c = chars[at] as string
    if (c === "\\") {
      const escaped = chars[++at]
      if (escaped === undefined) searchError("query.invalid-escape", { start: 0, end: value.length })
      pattern += /[|&?*+(){}[\].#@<>"~\\]/u.test(escaped) ? `\\${escaped}` : escaped
    } else pattern += c === "*" ? ".*" : c === "?" ? "." : /[|&?*+(){}[\].#@<>"~\\]/u.test(c) ? `\\${c}` : c
  }
  return pattern
}

const FOLD_RANGE = 4096
const unfoldable = (span: Span, what: string): never =>
  searchError(
    "query.unsupported-regex",
    span,
    `${what} has no single lowercase form without accents, which is what text: words are — write it that way, or use body:/…/ to match the original text`,
  )
const classChar = (point: number) => {
  const c = String.fromCodePoint(point)
  return /[\p{L}\p{N}]/u.test(c) ? c : `\\${c}`
}

/**
 * A `text:` regex with its literal characters folded as the word index folds words, since it runs over
 * that folded vocabulary. Operators, predefined classes and the case of `\D` `\W` `\S` stay as written.
 */
export const foldRegex = (pattern: string, span: Span): string => {
  const chars = [...pattern.normalize("NFC")]
  let out = ""
  let at = 0
  const literal = (c: string): string => {
    if (!/[\p{L}\p{N}\p{M}]/u.test(c)) return c
    const folded = fold(c)
    if (folded === "") return unfoldable(span, `"${c}"`)
    if ([...folded].length === 1 && /[\p{L}\p{N}]/u.test(folded)) return folded
    if (folded.includes('"')) return unfoldable(span, `"${c}"`)
    return `"${folded}"`
  }
  const characterClass = () => {
    const begin = at - 1
    let negate = ""
    if (chars[at] === "^") {
      negate = "^"
      at++
    }
    const kept: string[] = []
    const points = new Set<number>()
    do {
      const start = at
      if (chars[at] === "\\" && /^[a-zA-Z]$/u.test(chars[at + 1] ?? "")) {
        kept.push(`\\${chars[at + 1]}`)
        at += 2
        continue
      }
      const escaped = () => {
        if (chars[at] === "\\") at++
        return (chars[at++] ?? "").codePointAt(0) ?? 0
      }
      const lo = escaped()
      let hi = lo
      if (chars[at] === "-") {
        at++
        hi = escaped()
      }
      if (at > chars.length) {
        out += chars.slice(begin).join("")
        return
      }
      const single = (point: number) => [...fold(String.fromCodePoint(point))]
      if (hi < lo) kept.push(chars.slice(start, at).join(""))
      else if (hi - lo >= FOLD_RANGE) {
        if (single(lo).join("") !== String.fromCodePoint(lo) || single(hi).join("") !== String.fromCodePoint(hi))
          unfoldable(span, `the range ${chars.slice(start, at).join("")}`)
        kept.push(chars.slice(start, at).join(""))
      } else
        for (let point = lo; point <= hi; point++) {
          const folded = single(point)
          if (folded.length === 1) points.add(folded[0]?.codePointAt(0) ?? 0)
          else if (lo === hi) unfoldable(span, `"${String.fromCodePoint(point)}"`)
        }
    } while (at < chars.length && chars[at] !== "]")
    const sorted = [...points].sort((a, b) => a - b)
    const ranges: string[] = []
    for (let i = 0; i < sorted.length; i++) {
      const first = sorted[i] as number
      while (sorted[i + 1] === (sorted[i] as number) + 1) i++
      const last = sorted[i] as number
      ranges.push(last === first ? classChar(first) : `${classChar(first)}-${classChar(last)}`)
    }
    if (!kept.length && !ranges.length) unfoldable(span, "the class")
    out += `[${negate}${kept.join("")}${ranges.join("")}`
  }
  while (at < chars.length) {
    const c = chars[at++] as string
    if (c === "\\") {
      const next = chars[at++]
      if (next === undefined) out += c
      else out += (next.codePointAt(0) ?? 0) < 128 ? `${c}${next}` : literal(next)
    } else if (c === '"') {
      const end = chars.indexOf('"', at)
      if (end < 0) {
        out += chars.slice(at - 1).join("")
        break
      }
      const folded = fold(chars.slice(at, end).join(""))
      if (folded.includes('"')) unfoldable(span, `"${chars.slice(at, end).join("")}"`)
      out += `"${folded}"`
      at = end + 1
    } else if (c === "[") characterClass()
    else out += literal(c)
  }
  return out
}
