import type { BudgetStop, RunBudget } from "../background/budget.js"
import { headersOfRaw } from "./headers.js"
import { type Ranges, within } from "./resume.js"
import type { Listed, MailSource, Quick, Searched } from "./source.js"

export const FETCH_SLICE = 50
export const keyOf = (folder: string, uid: string) => `${folder}\0${uid}`

/** What a budgeted run carries from round to round that a quick folder also reads and writes. */
export interface QuickPlan {
  budget: RunBudget
  /** UIDs a round already asked for, `folder\0uid`. */
  tried: Set<string>
  /** Messages the source could not give; asked for once more when the pass is over. */
  failed: Set<string>
  unlisted: Set<string>
  /** Only these are asked for: the retry pass. */
  only?: Set<string>
  /** Each quick folder's listing of what was not done, made once; a round takes the next newest of it. */
  quick: Map<string, Quick[]>
  stopped: BudgetStop | null
  remaining: number
  asked: number
}

export interface QuickRead {
  /** Messages read and identified, with their raw bytes so the save does not read them again. */
  read: { item: Listed; raw: Uint8Array }[]
  unreadable: { message: string; reason: string }[]
  /** Mail of the folder is left for a later round or run. */
  capped: boolean
}

/**
 * One round of a folder whose server gives no cheap message id: UID, flags, date and size of what is not done, then
 * the raw bytes of the newest of it, whose Message-ID gives the id the full listing would have given.
 */
export const readQuick = async (
  source: MailSource & Required<Pick<MailSource, "quick" | "identify">>,
  since: Date,
  folder: string,
  searched: Searched,
  done: Ranges,
  max: number,
  plan: QuickPlan | undefined,
): Promise<QuickRead> => {
  const answer: QuickRead = { read: [], unreadable: [], capped: false }
  let items = plan?.quick.get(folder)
  if (items === undefined) {
    const asked = searched.uids.filter(
      (uid) => !within(done, Number(uid)) && (plan?.only === undefined || plan.only.has(keyOf(folder, uid))),
    )
    if (asked.length > 0 && plan) {
      const stop = plan.budget.take()
      if (stop) {
        plan.stopped = stop
        plan.remaining += asked.length
        return { ...answer, capped: true }
      }
    }
    items = asked.length === 0 ? [] : await source.quick(since, folder, { searched: { ...searched, uids: asked } })
    if (plan !== undefined) {
      plan.quick.set(folder, items)
      const got = new Set(items.map(({ uid }) => uid))
      for (const uid of asked)
        if (!got.has(uid)) {
          plan.failed.add(keyOf(folder, uid))
          plan.unlisted.add(keyOf(folder, uid))
        }
    }
  }
  const open = items
    .filter(({ uid }) => !within(done, Number(uid)) && !plan?.tried.has(keyOf(folder, uid)))
    .sort((a, b) => Number(b.uid) - Number(a.uid))
  const slice = open.slice(0, plan === undefined ? max : (source.fetchBatch ?? FETCH_SLICE))
  if (plan !== undefined) plan.remaining += open.length - slice.length
  answer.capped = open.length > slice.length
  if (slice.length === 0) return answer
  if (plan !== undefined) {
    const stop = plan.budget.take()
    if (stop) {
      plan.stopped = stop
      plan.remaining += slice.length
      return { ...answer, capped: true }
    }
    for (const { uid } of slice) plan.tried.add(keyOf(folder, uid))
    plan.asked += slice.length
  }
  const raws = await source.fetchRaw(slice)
  // Every email failing is the connection or the login, not the mail: stop instead of trying the rest.
  if (slice.length > 1 && raws.every((raw) => raw instanceof Error)) throw raws[0]
  for (const [index, item] of slice.entries()) {
    const raw = raws[index]
    const key = keyOf(folder, item.uid)
    if (raw === undefined || raw instanceof Error) {
      if (plan === undefined)
        answer.unreadable.push({ message: `uid:${folder}:${item.uid}`, reason: raw?.message ?? "not read" })
      else {
        plan.failed.add(key)
        plan.unlisted.add(key)
      }
      continue
    }
    plan?.unlisted.delete(key)
    answer.read.push({ item: { ...item, ...source.identify(raw, item), headers: headersOfRaw(raw) }, raw })
  }
  return answer
}
