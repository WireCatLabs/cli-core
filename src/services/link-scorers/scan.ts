import { CliError } from "@wirecat/cli-base"
import { parseReference } from "../../domain/references.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { BUILT_IN_PURPOSES } from "../project-purposes.js"
import { canonicalProjectRef } from "../stored-project-gathering.js"
import { aliasHits } from "./alias-hits.js"
import { chatSenders } from "./chat-senders.js"
import { chatTitle } from "./chat-title.js"
import { emailDomain } from "./email-domain.js"
import { mailThread } from "./mail-thread.js"
import { memberChats } from "./member-chats.js"
import { memberDialog } from "./member-dialog.js"
import { sameAccount } from "./shared.js"
import type {
  LinkCandidate,
  LinkScorer,
  ScannedProject,
  ScannedProposal,
  ScanResult,
  ScorerInput,
  Signal,
} from "./types.js"

/** A new scorer is one file and one line here. */
export const SCORERS: readonly LinkScorer[] = [chatTitle, aliasHits, memberChats, memberDialog, chatSenders, mailThread]

/** What a scan with no project runs: person ↔ person rules. */
export const PERSON_SCORERS: readonly LinkScorer[] = [emailDomain]

/** The rule bot every scan proposal is written by: only the owner decides its proposals. */
export const SCAN_BOT = { bot: "memo-scan", kind: "rule" } as const

export const DEFAULT_THRESHOLD = 0.5
/** A person ↔ person scan keeps the old rule's reach: one weak signal is enough to ask the owner. */
export const PERSON_THRESHOLD = 0.3
export const DEFAULT_LIMIT = 20

export interface ScanInput {
  /** A project's key, name, alias or `project:<id>`; `null` runs the person ↔ person rules. */
  project: string | null
  sources: AccountKey[]
  since: string
  /** `false` reads only: nothing is written, and each proposal says `dry-run`. */
  write: boolean
  scorers?: readonly LinkScorer[]
  threshold?: number
  /** Most new proposals in one run, 1–50. */
  limit?: number
  /** The host's configured purposes; built-in when left out. */
  purposes?: readonly string[]
  signal?: AbortSignal
}

const projectOf = async (store: MessageStore, reference: string): Promise<ScannedProject> => {
  const ref = await canonicalProjectRef(store, reference)
  const entry = (await store.knowledge.vocabulary({ kind: "project" })).entries.find((one) => one.id === ref.slice(8))
  if (!entry) throw new CliError("not_found", `no project ${reference}`)
  return { ref, name: entry.name, key: entry.key, aliases: entry.aliases.map((alias) => alias.name) }
}

const confirmedOf = async (store: MessageStore, project: ScannedProject | null) => {
  if (!project) return { chats: [], people: [] }
  const members = (await store.knowledge.relations(null, project.ref)).filter(
    (one) => one.confirmed && one.kind === "member-of" && one.to === project.ref,
  )
  return {
    chats: [...new Set(members.map((one) => one.from).filter((ref) => ref.startsWith("chat:")))].sort(),
    people: [...new Set(members.map((one) => one.from).filter((ref) => ref.startsWith("person:")))].sort(),
  }
}

const checkedSources = async (store: MessageStore, sources: AccountKey[]): Promise<AccountKey[]> => {
  const stored = await store.accounts.accounts()
  const choices = stored.map((one) => `${one.provider}:${one.account}`)
  if (!Array.isArray(sources) || sources.length === 0)
    throw new CliError("validation_error", "a scan names the accounts it reads; none is picked for you", {
      param: "source",
      choices,
    })
  for (const source of sources)
    if (!stored.some((one) => one.provider === source.provider && String(one.account) === String(source.account)))
      throw new CliError("not_found", `the store holds no account ${source.provider}:${source.account}`, {
        param: "source",
        choices,
      })
  return sources
}

const pairKey = ({ from, to, kind }: LinkCandidate) => `${from}\u0000${to}\u0000${kind}`

/** 1 − Π(1 − wᵢ), over each scorer's strongest signal for the pair. */
export const combinedScore = (weights: readonly number[]): number =>
  Math.round((1 - weights.reduce((left, weight) => left * (1 - weight), 1)) * 1000) / 1000

/**
 * Runs the scorers for one project over the sources named, combines their signals per pair, and proposes what scores
 * `threshold` or more, highest first, at most `limit` new ones. A pair a link joins, or that was rejected once, is
 * never proposed; a pending one is updated in place. People are matched by identity only. With `write: false`
 * nothing is written.
 */
export const scanProjectLinks = async (store: MessageStore, input: ScanInput): Promise<ScanResult> => {
  const limit = input.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new CliError("validation_error", "a scan proposes 1–50 links a run", { param: "limit" })
  const threshold = input.threshold ?? (input.project === null ? PERSON_THRESHOLD : DEFAULT_THRESHOLD)
  if (typeof threshold !== "number" || !(threshold > 0 && threshold <= 1))
    throw new CliError("validation_error", "a scan's threshold is more than 0 and at most 1", { param: "threshold" })
  const since = Date.parse(input.since)
  if (Number.isNaN(since))
    throw new CliError("validation_error", "a scan's window starts at an ISO 8601 time", { param: "since" })
  const sources = await checkedSources(store, input.sources)
  const project = input.project === null ? null : await projectOf(store, input.project)
  const owner = await store.people.owner()
  const scorerInput: ScorerInput = {
    store,
    project,
    confirmed: await confirmedOf(store, project),
    sources,
    since: new Date(since).toISOString(),
    purposes: input.purposes ?? BUILT_IN_PURPOSES,
    owner: owner ? `person:${owner.uid}` : null,
    ...(input.signal ? { signal: input.signal } : {}),
  }
  const scorers = input.scorers ?? (project ? SCORERS : PERSON_SCORERS)
  const skipped: ScanResult["skipped"] = {
    confirmed: 0,
    rejected: 0,
    belowThreshold: 0,
    overLimit: 0,
    nameOnly: 0,
    unresolved: 0,
  }

  const pairs = new Map<string, { candidate: LinkCandidate; signals: Map<string, Signal & { purpose?: string }> }>()
  const nameOnly = new Set<string>()
  for (const scorer of scorers) {
    input.signal?.throwIfAborted()
    for (const candidate of await scorer.candidates(scorerInput)) {
      const key = pairKey(candidate)
      const verdict = await admissible(store, scorerInput, candidate)
      if (verdict === "owner") continue
      if (verdict === "name-only") {
        if (!nameOnly.has(key)) skipped.nameOnly++
        nameOnly.add(key)
        continue
      }
      if (verdict !== "ok") {
        skipped.unresolved++
        continue
      }
      const weight = Math.min(1, Math.max(0, candidate.weight))
      const held = pairs.get(key) ?? { candidate, signals: new Map() }
      const scorerId = `${scorer.id}@${scorer.version}`
      const before = held.signals.get(scorerId)
      if (!before || before.weight < weight)
        held.signals.set(scorerId, {
          scorer: scorerId,
          weight,
          why: candidate.why.slice(0, 500),
          ...(candidate.purpose && scorerInput.purposes.includes(candidate.purpose)
            ? { purpose: candidate.purpose }
            : {}),
        })
      held.candidate = {
        ...held.candidate,
        evidence: [...new Set([...held.candidate.evidence, ...candidate.evidence])],
      }
      pairs.set(key, held)
    }
  }

  const scored = [...pairs.values()]
    .map(({ candidate, signals }) => {
      const list = [...signals.values()].sort((a, b) => b.weight - a.weight || a.scorer.localeCompare(b.scorer))
      const purpose = list.find((one) => one.purpose)?.purpose
      return {
        candidate,
        purpose,
        signals: list.map(({ scorer, weight, why }) => ({ scorer, weight, why })),
        score: combinedScore(list.map((one) => one.weight)),
      }
    })
    .sort((a, b) => b.score - a.score || a.candidate.from.localeCompare(b.candidate.from))

  const proposals: ScannedProposal[] = []
  let fresh = 0
  for (const { candidate, purpose, signals, score } of scored) {
    const state = await store.knowledge.relationState(null, candidate)
    if (!state) {
      skipped.unresolved++
      continue
    }
    if (state.linked) {
      skipped.confirmed++
      continue
    }
    if (state.rejected || (await rejectedReversed(store, candidate))) {
      skipped.rejected++
      continue
    }
    if (score < threshold) {
      skipped.belowThreshold++
      continue
    }
    if (!state.pending && fresh >= limit) {
      skipped.overLimit++
      continue
    }
    if (!state.pending) fresh++
    const { identity: _identity, purpose: _purpose, weight: _weight, why: _why, ...pair } = candidate
    const evidence = candidate.evidence.slice(0, 5)
    const proposal = {
      ...pair,
      weight: score,
      why: signals.map((one) => one.why).join("; "),
      evidence,
      ...(purpose ? { purpose } : {}),
      score,
      signals,
    }
    if (!input.write) {
      proposals.push({ ...proposal, id: state.pending?.id ?? null, state: "dry-run" })
      continue
    }
    const written = await store.knowledge.proposeRelation(
      null,
      {
        from: pair.from,
        to: pair.to,
        kind: pair.kind,
        evidence,
        reason: proposal.why.slice(0, 2000),
        score,
        signals,
        ...(purpose ? { purpose } : {}),
      },
      SCAN_BOT,
    )
    proposals.push({
      ...proposal,
      id: written.id,
      state: !state.pending
        ? "new"
        : JSON.stringify(written.payload) === JSON.stringify(state.pending.payload)
          ? "unchanged"
          : "updated",
    })
  }
  return { project: project?.ref ?? null, proposals, skipped }
}

/** A person candidate stands only on an identity that is that person's; a chat only in a source the scan reads. */
const admissible = async (
  store: MessageStore,
  input: ScorerInput,
  candidate: LinkCandidate,
): Promise<"ok" | "owner" | "name-only" | "unresolved"> => {
  if (candidate.from === candidate.to || !Number.isFinite(candidate.weight)) return "unresolved"
  if (input.project && candidate.to !== input.project.ref && !candidate.to.startsWith("person:")) return "unresolved"
  if (candidate.from === input.owner || candidate.to === input.owner) return "owner"
  if (candidate.from.startsWith("person:")) {
    const identity = candidate.identity === undefined ? undefined : referenceOf(candidate.identity)
    if (identity?.type !== "contact") return "name-only"
    const person = await store.people.personOf({ provider: identity.provider, id: identity.id })
    return person !== undefined && `person:${person.uid}` === candidate.from ? "ok" : "name-only"
  }
  if (candidate.from.startsWith("chat:")) {
    const chat = referenceOf(candidate.from)
    return chat?.type === "chat" && input.sources.some((source) => sameAccount(source, chat)) ? "ok" : "unresolved"
  }
  return "unresolved"
}

const referenceOf = (text: string) => {
  try {
    return parseReference(text)
  } catch {
    return undefined
  }
}

/** A person ↔ person relation reads both ways: rejecting B → A also rejects A → B. */
const rejectedReversed = async (store: MessageStore, candidate: LinkCandidate): Promise<boolean> =>
  candidate.kind === "related-to" &&
  candidate.to.startsWith("person:") &&
  ((await store.knowledge.relationState(null, { from: candidate.to, to: candidate.from, kind: candidate.kind }))
    ?.rejected ??
    false)
