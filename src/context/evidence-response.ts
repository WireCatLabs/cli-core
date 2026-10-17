import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import {
  type ContextEvidencePage,
  type ContextEvidenceRequest,
  contextEvidenceRequest,
  contextSource,
} from "./evidence.js"

export const contextSourceKey = (source: ReturnType<typeof contextSource>) =>
  JSON.stringify([source.kind, source.accountId, source.provider, source.account])

export const validateContextEvidencePage = (page: ContextEvidencePage, request: ContextEvidenceRequest) => {
  const fail = (): never => {
    throw new CliError("invalid_response", "context reader returned invalid or out-of-scope evidence")
  }
  try {
    const { source, after, before, limit, maxReadBytes } = contextEvidenceRequest(request)
    if (!page || contextSourceKey(contextSource(page.source)) !== contextSourceKey(source)) fail()
    if (
      !Array.isArray(page.items) ||
      page.items.length > limit ||
      !Number.isSafeInteger(page.readBytes) ||
      page.readBytes < 0 ||
      page.readBytes > maxReadBytes
    )
      fail()
    const c = page.coverage
    if (
      !c ||
      typeof c.available !== "boolean" ||
      typeof c.hasMore !== "boolean" ||
      typeof c.hasUndated !== "boolean" ||
      !["ready", "pending", "missing", "unknown"].includes(c.index) ||
      c.matching !== "literal-words" ||
      c.completeness !== "unknown" ||
      c.consistency !== "snapshot-per-page"
    )
      fail()
    if (
      (!c.available && page.items.length > 0) ||
      c.hasMore !== Boolean(page.next) ||
      page.next === undefined ||
      (page.next !== null && typeof page.next !== "object")
    )
      fail()
    if (page.next) contextEvidenceRequest({ ...request, cursor: page.next })
    let actual = 0
    for (const item of page.items) {
      if (
        !item ||
        item.provider !== source.provider ||
        item.account !== source.account ||
        typeof item.text !== "string" ||
        typeof item.ref !== "string"
      )
        fail()
      if (
        !Number.isSafeInteger(item.at) ||
        item.at < after ||
        item.at >= before ||
        !Number.isSafeInteger(item.updatedAt) ||
        item.updatedAt < 0
      )
        fail()
      if (item.revision !== null && (!Number.isSafeInteger(item.revision) || item.revision < 1)) fail()
      if (
        !["source-modified", "stored-update", "sent"].includes(item.timeKind) ||
        (source.kind !== "document" && item.timeKind !== "sent") ||
        (source.kind === "document" && item.timeKind === "sent")
      )
        fail()
      const text = [item.text, item.title, item.url, item.provider, item.account, item.timeKind]
      if (text.some((value) => value !== null && typeof value !== "string")) fail()
      if (source.kind === "document") {
        const id = Number(item.ref.slice(9))
        if (!Number.isSafeInteger(id) || id < 1 || item.ref !== `document:${id}`) fail()
      } else {
        const locator = parseLocator(item.ref)
        if (
          locator.provider !== source.provider ||
          locator.account !== source.account ||
          formatLocator(locator) !== item.ref
        )
          fail()
        text.push(locator.chat, locator.message)
      }
      actual += text.reduce<number>((sum, value) => sum + (value === null ? 0 : Buffer.byteLength(value)), 0)
    }
    if (actual > page.readBytes) fail()
  } catch (error) {
    if (error instanceof CliError && error.code === "invalid_response") throw error
    fail()
  }
}
