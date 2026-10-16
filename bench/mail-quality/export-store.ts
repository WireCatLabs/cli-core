import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { parseLocator } from "../../dist/domain/locator.js"
import { openStore } from "../../dist/store/store.js"

/**
 * One mailbox of a real store, with questions its owner wrote, as the benchmark's corpus: the same shape as
 * corpus.json, so run.ts measures it unchanged. It reads a copy of the store, never the store itself.
 *
 *   node bench/mail-quality/export-store.ts --store <db> --account <address> --queries <file> > <private corpus>
 *
 * Questions file: [{ "id": "q1", "text": "...", "relevant": ["msg:email/…"], "split"?: "dev" | "test" }]; each
 * locator is one `search mail` or `mail show` gave. The output holds the mail's text: keep it out of public repos.
 */
type Question = { id: string; split?: "dev" | "test"; text: string; relevant: string[] }

const { values } = parseArgs({
  options: { store: { type: "string" }, account: { type: "string" }, queries: { type: "string" } },
})
assert.ok(values.store && values.account && values.queries, "--store, --account and --queries are all needed")
const copy = join(mkdtempSync(join(tmpdir(), "mail-quality-own-")), "store.db")
copyFileSync(values.store, copy)
const questions = JSON.parse(readFileSync(values.queries, "utf8")) as Question[]

const store = await openStore({ path: copy })
try {
  const { id: accountId } = await store.accounts.storedAccount({ provider: "email", account: values.account })
  const threads = new Map<number, { id: string; subject: string; emails: unknown[] }>()
  for (let offset = 0; ; offset += 500) {
    const page = await store.mail.threads({ accountId, limit: 500, offset })
    for (const thread of page) threads.set(thread.id, { id: thread.externalId, subject: thread.subject ?? "", emails: [] })
    if (page.length < 500) break
  }
  const held = new Set<string>()
  for (let offset = 0; ; offset += 500) {
    const page = await store.mail.emails({ accountId, limit: 500, offset })
    for (const email of page) {
      const thread = threads.get(email.emailThreadId)
      if (!thread) continue
      held.add(email.externalId)
      thread.emails.push({
        id: email.externalId,
        from: email.fromName ?? email.fromAddress ?? "",
        at: new Date(email.sentAt ?? email.receivedAt ?? email.createdAt).toISOString(),
        body: email.bodyText ?? "",
      })
    }
    if (page.length < 500) break
  }
  const queries = questions.map(({ id, split = "dev", text, relevant }) => ({
    id,
    split,
    lang: "own",
    category: "own",
    text,
    relevant: relevant.map((locator) => {
      const { message } = parseLocator(locator)
      assert.ok(held.has(message), `${id}: ${locator} is not an email of ${values.account}`)
      return message
    }),
  }))
  const corpus = [...threads.values()]
    .filter(({ emails }) => emails.length > 0)
    .map((thread) => ({
      ...thread,
      emails: (thread.emails as { at: string }[]).sort((a, b) => a.at.localeCompare(b.at)),
    }))
  console.log(JSON.stringify({ threads: corpus, queries }))
} finally {
  await store.close()
}
