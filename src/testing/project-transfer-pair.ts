import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache } from "../store/open.js"
import { snapshotProjectAnnotations } from "../store/project-transfer/snapshot.js"
import { openStore } from "../store/store.js"
import { projectSnapshotFixture } from "./project-snapshot.js"

export const projectTransferPairFixture = async () => {
  const source = await projectSnapshotFixture()
  const directory = mkdtempSync(join(tmpdir(), "project-preview-target-"))
  const path = join(directory, "target.db")
  const store = await openStore({ path, now: () => source.at + 1000 })
  try {
    const unrelated = await store.knowledge.addProject({ name: "Unrelated baseline", key: "PAD" })
    await store.knowledge.addOrganization({ name: "Padding organization", kind: "company" })
    const organization = await store.knowledge.addOrganization({ name: "Synthetic laboratory", kind: "company" })
    await store.facts.add({
      type: "statement",
      statement: "Padding actor",
      project: unrelated.ref,
      by: { bot: "padding" },
    })
    const actor = await store.facts.add({
      type: "statement",
      statement: "Separate baseline",
      project: unrelated.ref,
      by: { bot: "target-reviewer" },
    })
    const project = await store.knowledge.addProject({ name: "Research", key: "RES" })
    const folder = await store.notes.addFolder({ name: "Independent target sources" })
    await store.notes.saveFileNote({ folderId: folder.id, path: "padding.md", title: "Padding", text: "Unrelated" })
    const { note: document } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "evidence.md",
      title: "Evidence",
      text: source.corpus,
    })
    const snapshot = await snapshotProjectAnnotations({ source: source.path, project: source.project.ref })
    const bindings: Record<string, string> = {
      [source.project.ref]: project.ref,
      [source.org.ref]: organization.ref,
      [source.document.ref]: document.ref,
      [`bot:${source.proposed.author.id}`]: `bot:${actor.author.id}`,
      "person:1": "person:1",
    }
    const db = await openCache(path)
    return {
      source,
      path,
      store,
      db,
      project,
      unrelated,
      document,
      bindings,
      snapshot: JSON.stringify(snapshot.snapshot),
      close: async () => {
        db.close()
        await store.close()
        await source.close()
        rmSync(directory, { recursive: true, force: true })
        rmSync(source.directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await store.close()
    await source.close()
    throw error
  }
}
