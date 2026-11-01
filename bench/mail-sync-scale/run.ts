import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { runBudget } from "../../dist/background/budget.js"
import { syncMail } from "../../dist/mail/sync.js"
import { type FakeMail, fakeMailSource } from "../../dist/mail/testing/index.js"
import { openStore } from "../../dist/store/store.js"

// MAIL_SCALE_STORE reuses a seeded store, so a second measurement does not pay for the seeding again.
const STORED = Number(process.env.MAIL_SCALE_STORED ?? 260_000)
const WINDOW = Number(process.env.MAIL_SCALE_WINDOW ?? 4_900)
const LABELS = ["INBOX", "Important", "Category/Updates", "Category/Promotions"]
const ME = "owner@example.test"
const NOW = Date.parse("2026-11-01T12:00:00Z")
const SINCE = new Date(NOW - 30 * 86_400_000)

const path = process.env.MAIL_SCALE_STORE ?? join(mkdtempSync(join(tmpdir(), "mail-scale-")), "messages.db")
const seeded = existsSync(path)
const env = { ...process.env, MESSAGING_STORE: path }

const at = (n: number) =>
  n < WINDOW ? NOW - 86_400_000 - n * Math.floor((28 * 86_400_000) / WINDOW) : SINCE.getTime() - (n - WINDOW) * 60_000
const window: FakeMail[] = Array.from({ length: WINDOW }, (_, n) => ({
  uid: String(1_000_000 - n),
  messageId: `m${n}`,
  threadId: `t${n}`,
  receivedAt: new Date(at(n)).toISOString(),
  subject: `Synthetic subject ${n}`,
  from: ["Rin Example", `rin${n % 500}@example.test`],
  to: [[null, ME]],
  text: `Synthetic body ${n}`,
  labels: LABELS.slice(0, 1 + (n % LABELS.length)),
}))

let peak = 0
const sample = () => {
  peak = Math.max(peak, process.memoryUsage().rss)
}
const sampler = setInterval(sample, 20)

const store = await openStore({ env })
const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: ME })
if (!seeded) {
  const began = performance.now()
  for (let start = 0; start < STORED; start += 2_000) {
    const batch = []
    for (let n = start; n < Math.min(STORED, start + 2_000); n++)
      batch.push({
        accountId,
        externalId: `t${n}`,
        now: NOW,
        emails: [
          {
            externalId: `m${n}`,
            subject: `Synthetic subject ${n}`,
            from: { address: `rin${n % 500}@example.test`, name: "Rin Example" },
            sentAt: at(n),
            receivedAt: at(n),
            bodyText: `Synthetic body ${n}`,
            mailboxes: [
              { externalId: "[Gmail]/All Mail", name: "[Gmail]/All Mail", kind: null },
              ...LABELS.slice(0, 1 + (n % LABELS.length)).map((name) => ({
                externalId: `label:${name}`,
                name,
                kind: "label",
              })),
            ],
          },
        ],
      })
    await store.mail.saveThreads(batch, [])
  }
  console.error(`seeded ${STORED} emails in ${Math.round(performance.now() - began)} ms`)
}

const calls = { search: 0, list: 0, fetchRaw: 0 }
const source = fakeMailSource({ messages: window, calls })
const refs = store.mail.emailRefs.bind(store.mail)
let refScans = 0
store.mail.emailRefs = (filter) => {
  refScans++
  return refs(filter)
}
global.gc?.()
peak = process.memoryUsage().rss
const before = peak
const began = performance.now()
const report = await syncMail(source, store, {
  account: { address: ME, mode: "gmail", folders: ["[Gmail]/All Mail"] },
  since: SINCE,
  budget: runBudget({ requests: 200 }),
})
const ms = Math.round(performance.now() - began)
sample()
clearInterval(sampler)
await store.close()
console.log(
  JSON.stringify({
    stored: STORED,
    window: WINDOW,
    ms,
    rss_before_mb: Math.round(before / 1048576),
    rss_peak_mb: Math.round(peak / 1048576),
    emailRefs_calls: refScans,
    requests: report.requests,
    listed: report.listed,
    saved: report.saved,
    already_stored: report.alreadyStored,
    state: report.state,
    store: path,
  }),
)
