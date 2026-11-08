import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("moves a free-text role of a person on a project or organization into the role note, and keeps every other role", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-59-")), "wirecat.db")
  const store = await openStore({ path })
  const project = (await store.knowledge.addProject({ name: "Harbour" })).id
  const organization = (await store.knowledge.addOrganization({ kind: "company", name: "Acme Ltd" })).id
  const ids: Record<string, number> = {}
  for (const name of ["Ann", "Ben", "Cal", "Dee", "Eve"]) ids[name] = Number((await store.people.add({ name })).uid)
  await store.knowledge.addRole("project", "sponsor")
  await store.close()

  const old = await openCache(path)
  rollBackTo(old, 59)
  const insert = old.prepare(
    "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, metadata, source, confirmed, created_at, author, " +
      "updated_at) VALUES ('person', ?, ?, ?, 'member-of', ?, ?, 'owner', 1, 1, 'owner', 1) RETURNING id",
  )
  const link = (name: string, to: "project" | "organization", role: string | null, metadata: string | null = null) =>
    Number(insert.get(ids[name] ?? 0, to, to === "project" ? project : organization, role, metadata)?.id)
  const free = link("Ann", "project", "клиент, принимает решения (Ann)", JSON.stringify({ position: "CEO" }))
  const listed = link("Ben", "project", "approver")
  const own = link("Cal", "project", "sponsor")
  const beside = link("Dee", "project", "заказчик")
  const unset = link("Dee", "project", null)
  const first = link("Eve", "project", "ведёт бюджет")
  const second = link("Eve", "project", "подписывает акты")
  const title = link("Ann", "organization", "CTO")
  old.close()

  const upgraded = await openStore({ path })
  try {
    const db = await openCache(path)
    const row = (id: number) => db.prepare("SELECT role, metadata FROM links WHERE id = ?").get(id)
    try {
      expect(row(free)).toEqual({
        role: null,
        metadata: JSON.stringify({ position: "CEO", roleNote: "клиент, принимает решения (Ann)" }),
      })
      expect(row(title)).toEqual({ role: null, metadata: JSON.stringify({ roleNote: "CTO" }) })
      expect(row(first)).toEqual({ role: null, metadata: JSON.stringify({ roleNote: "ведёт бюджет" }) })
      expect(row(second)).toEqual({ role: "подписывает акты", metadata: null })
      expect(row(beside)).toEqual({ role: "заказчик", metadata: null })
      expect(row(unset)).toEqual({ role: null, metadata: null })
      expect(row(listed)).toEqual({ role: "approver", metadata: null })
      expect(row(own)).toEqual({ role: "sponsor", metadata: null })
      expect(db.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 59").get()).toEqual({
        min_compatible: 56,
      })
      expect(
        db
          .prepare(
            "SELECT json_extract(before, '$.role') AS role FROM link_revisions WHERE link_id = ? ORDER BY id DESC LIMIT 1",
          )
          .get(free),
      ).toEqual({ role: "клиент, принимает решения (Ann)" })
    } finally {
      db.close()
    }
    const moved = await upgraded.knowledge.updateRelation(null, String(free), {
      role: "approver",
      engagement: "low",
      by: "owner",
    })
    expect(moved).toMatchObject({
      role: "approver",
      roleNote: "клиент, принимает решения (Ann)",
      engagement: "low",
      position: "CEO",
    })
  } finally {
    await upgraded.close()
  }
})
