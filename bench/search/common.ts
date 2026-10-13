import { appendFileSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

// On disk and shared by every worktree: /tmp is RAM here, and the 1M corpus takes 21 s to regenerate.
export const DATA_DIR =
  process.env.SEARCHBENCH_DATA ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cli-core", "searchbench")
export const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
export const RESULTS = join(BENCH_DIR, "results.md")
export const RUNTIME = (globalThis as any).Bun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.version}`

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .toLowerCase()
}

export function tokens(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

// Optimal string alignment (restricted Damerau-Levenshtein), early exit above max.
export function damerau(a: string, b: string, max: number): number {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > max) return max + 1
  let prev2 = new Array(lb + 1).fill(0)
  let prev = Array.from({ length: lb + 1 }, (_, j) => j)
  let cur = new Array(lb + 1).fill(0)
  for (let i = 1; i <= la; i++) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    ;[prev2, prev, cur] = [prev, cur, prev2]
  }
  return prev[lb]
}

export function trigrams(term: string): string[] {
  const padded = `  ${term} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3))
  return [...out]
}

export function maxEdits(term: string): number {
  return term.length <= 4 ? 1 : 2
}

export function pick<T extends { dist: number; df: number }>(cands: T[]): T[] {
  if (!cands.length) return []
  const best = Math.min(...cands.map((c) => c.dist))
  return cands
    .filter((c) => c.dist === best)
    .sort((x, y) => y.df - x.df)
    .slice(0, 5)
}

export function pctl(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}

export function fmt(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0)
}

export function out(line = "") {
  appendFileSync(RESULTS, `${line}\n`)
  console.log(line)
}

export function du(path: string): number {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const e of readdirSync(path)) total += du(join(path, e))
  return total
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

export function maxRssMb(): number {
  return Math.round(process.resourceUsage().maxRSS / 1024)
}

export type Meta = {
  n: number
  seed: number
  bigChat: number
  smallChat: number
  smallChatCount: number
  sender: number
  senderCount: number
  /** The chats nearest 10k, 50k and 100k messages, where the corpus has them: where the scope token and the join cross. */
  sizedChats?: { target: number; chat: number; count: number }[]
  minTs: number
  maxTs: number
  queries: { typical: string[][]; three: string[][]; common: string[][] }
}

export type Truth = Record<string, number[]>

export function loadMeta(n: number): { meta: Meta; truth: Truth } {
  return {
    meta: JSON.parse(readFileSync(join(DATA_DIR, `meta-${n}.json`), "utf8")),
    truth: JSON.parse(readFileSync(join(DATA_DIR, `truth-${n}.json`), "utf8")),
  }
}

export const FUZZY: { query: string; truthKey: string }[] = [
  { query: "Valenca", truthKey: "valencia" },
  { query: "empadronamento", truthKey: "empadronamiento" },
  { query: "Ptsharev", truthKey: "ptsarev" },
  { query: "whatsap", truthKey: "whatsapp" },
]

/** Real words one edit from a target, planted 1 in 10,000 each: a correction may pick them too (plan item 8). */
export const LOOKALIKES: { forms: string[]; truthKey: string }[] = [
  { forms: ["valence", "Valence"], truthKey: "valencia" },
  { forms: ["empadronamientos"], truthKey: "empadronamiento" },
  { forms: ["Ptsharov"], truthKey: "ptsarev" },
  { forms: ["whatsup"], truthKey: "whatsapp" },
]

export const EXACT: { label: string; query: string; truthKey: string }[] = [
  { label: "accent: València", query: "València", truthKey: "valencia" },
  { label: "Cyrillic: счёт", query: "счёт", truthKey: "счет" },
  { label: "Cyrillic: СЧЕТ", query: "СЧЕТ", truthKey: "счет" },
]

export type Filter = { label: string; chat?: number; sender?: number; from?: number; to?: number }

export function filters(meta: Meta): Filter[] {
  const day = 86400
  return [
    { label: "all" },
    { label: "big chat (50%)", chat: meta.bigChat },
    { label: `small chat (${meta.smallChatCount} msgs)`, chat: meta.smallChat },
    { label: "date: last 30 days", from: meta.maxTs - 30 * day, to: meta.maxTs },
    { label: `sender (${meta.senderCount} msgs)`, sender: meta.sender },
    { label: "big chat + last 90 days", chat: meta.bigChat, from: meta.maxTs - 90 * day, to: meta.maxTs },
  ]
}

export function recall(got: Iterable<number>, truth: number[]): { recall: number; precision: number; n: number } {
  const t = new Set(truth)
  let hit = 0
  let n = 0
  for (const id of got) {
    n++
    if (t.has(id)) hit++
  }
  return { recall: truth.length ? hit / truth.length : 1, precision: n ? hit / n : 0, n }
}
