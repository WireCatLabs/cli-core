import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const MAIL: AccountKey = { provider: "email", account: "me@acme.example.com" }
const NOW = Date.parse("2026-11-26T12:00:00Z")

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

it("moves the agents' `bot` to `agent` in pairs and refs, then a sender bot's `sender-bot:` to `bot:`", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-78-")), "store.db")
  const store = await openStore({ path })
  await store.accounts.saveAccount(MAIL, { name: null })
  await store.people.savePeople(MAIL, [{ id: "noreply@bank.example.com", name: "Bank" }])
  await store.close()
  const old = await openCache(path)
  rollBackTo(old, 78)
  const agent = Number(old.prepare("SELECT id FROM bots WHERE name = 'agent'").get()?.id)
  const identity = Number(
    old.prepare("SELECT id FROM identities WHERE external_id = 'noreply@bank.example.com'").get()?.id,
  )
  const link = (fromType: string, targetText: string | null, metadata: string | null, evidence: string | null) =>
    old
      .prepare(
        "INSERT INTO links (from_type, from_id, kind, source, target_text, metadata, evidence, created_at, updated_at) " +
          "VALUES (?, ?, 'related-to', 'manual', ?, ?, ?, ?, ?)",
      )
      .run(fromType, agent, targetText, metadata, evidence, NOW, NOW)
  link("bot", "bot:7", JSON.stringify({ gone: "bot" }), "agent:claude: it looked the same")
  link("person", "telegram-bot:9", null, null)
  old
    .prepare(
      "INSERT INTO proposed_actions (kind, status, proposed_by_type, proposed_by_id, payload, created_at, updated_at) " +
        "VALUES ('link', 'pending', 'bot', ?, ?, ?, ?)",
    )
    .run(agent, JSON.stringify({ from: "bot:7", to: "person:1", ref: "sender-bot:3" }), NOW, NOW)
  const rule = Number(
    old
      .prepare(
        "INSERT INTO mail_sort_rules (scope, value, over_addresses, past, author, created_at, updated_at) " +
          "VALUES ('address', 'noreply@bank.example.com', 0, 1, 'owner', ?, ?) RETURNING id",
      )
      .get(NOW, NOW)?.id,
  )
  old
    .prepare(
      'INSERT INTO mail_sort_effects (rule_id, identity_id, action, "before", "after", created_at) ' +
        "VALUES (?, ?, 'sender', 'sender-bot:3 rules', 'person:1', ?), " +
        "(?, ?, 'sender', 'person:9 owner', 'sender-bot:3', ?)",
    )
    .run(rule, identity, NOW, rule, identity, NOW)
  old.close()

  handles.push(await openStore({ path }))
  const after = await openCache(path)
  handles.push(after)

  expect(after.prepare("SELECT from_type, target_text, metadata, evidence FROM links ORDER BY id").all()).toEqual([
    {
      from_type: "agent",
      target_text: "agent:7",
      metadata: JSON.stringify({ gone: "agent" }),
      evidence: "agent:claude: it looked the same",
    },
    { from_type: "person", target_text: "telegram-bot:9", metadata: null, evidence: null },
  ])
  const proposal = after.prepare("SELECT proposed_by_type, payload FROM proposed_actions").get()
  expect(proposal?.proposed_by_type).toBe("agent")
  expect(JSON.parse(String(proposal?.payload))).toEqual({ from: "agent:7", to: "person:1", ref: "sender-bot:3" })
  expect(after.prepare('SELECT "before", "after" FROM mail_sort_effects ORDER BY id').all()).toEqual([
    { before: "bot:3 rules", after: "person:1" },
    { before: "person:9 owner", after: "bot:3" },
  ])
  expect(after.prepare("SELECT min_compatible AS n FROM schema_migrations WHERE version = 78").get()?.n).toBe(78)
})
