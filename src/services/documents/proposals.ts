import { CliError } from "@wirecat/cli-base"
import type { SourceContent } from "../../documents/model.js"
import type { Fact, Memory } from "../../store/index.js"
import { type Complete, extractMemories } from "./extraction.js"
import type { DocumentKnowledge } from "./knowledge.js"

export interface ImportedSource {
  id: string
  ref: string
  hash: string
  snapshot: SourceContent
}
export interface ProposalOptions {
  read(): ImportedSource
  complete: Complete
  scope: Memory["scope"]
  author: string
  tab?: string
  save?: boolean
  withWrite<T>(fn: (knowledge: DocumentKnowledge, principal: string, ref: string) => Promise<T>): Promise<T>
}
export const extractDocumentMemories = async (options: ProposalOptions) => {
  const source = options.read()
  const text = options.tab ? source.snapshot.tabs.find((tab) => tab.id === options.tab)?.text : source.snapshot.text
  if (text === undefined) throw new CliError("not_found", "tab was not found in this imported document")
  const result = await extractMemories(text, options.complete)
  const assertCurrent = () => {
    if (options.read().hash !== source.hash)
      throw new CliError("validation_error", "source changed during extraction; no memories were saved", {
        reason: "document.changed",
      })
  }
  assertCurrent()
  const saved: (Fact | Memory)[] = options.save
    ? await options.withWrite(async (knowledge, principal, ref) => {
        assertCurrent()
        if (ref !== source.ref)
          throw new CliError("validation_error", "source changed during extraction; no memories were saved", {
            reason: "document.changed",
          })
        const items: (Fact | Memory)[] = []
        const by = { bot: options.author, model: result.model }
        for (const item of result.items) {
          const body = `${item.body}\n\nSource quote: ${item.quote}\nSnapshot: ${source.hash}`
          items.push(
            item.kind === "fact"
              ? await knowledge.addFact(principal, ref, { statement: body, type: "fact", scope: options.scope, by })
              : await knowledge.addMemory(principal, ref, {
                  kind: item.kind,
                  body,
                  scope: options.scope,
                  status: "proposed",
                  author: by,
                }),
          )
        }
        return items
      })
    : []
  return {
    ...result,
    provenance: {
      document: source.ref,
      file_id: source.id,
      hash: source.hash,
      url: source.snapshot.metadata.url,
      tab: options.tab ?? null,
    },
    saved,
  }
}
