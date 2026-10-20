import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache } from "../store/open.js"
import { openStore } from "../store/store.js"

export const projectSnapshotFixture = async (padding = false) => {
  const directory = mkdtempSync(join(tmpdir(), "project-snapshot-")),
    path = join(directory, "store.db")
  const at = 1700000000000,
    store = await openStore({ path, now: () => at })
  try {
    if (padding) {
      const unrelated = await store.knowledge.addProject({ name: "Unrelated", key: "IGN" })
      await store.facts.add({
        type: "statement",
        statement: "Unrelated record",
        project: unrelated.ref,
        by: { bot: "padding" },
      })
    }
    const org = await store.knowledge.addOrganization({ name: "Synthetic laboratory", kind: "company" })
    const project = await store.knowledge.addProject({
      name: "Research",
      key: "RES",
      organization: org.ref,
      description: "A synthetic study",
    })
    await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "Studies")
    const folder = await store.notes.addFolder({ name: "Synthetic corpus" })
    if (padding)
      await store.notes.saveFileNote({
        folderId: folder.id,
        path: "unrelated.md",
        title: "Unrelated",
        text: "Other material",
      })
    const corpus = `INVENTED_CORPUS_SENTINEL\n${"x".repeat(8192)}`
    const { note: document } = await store.notes.saveFileNote({
      folderId: folder.id,
      path: "evidence.md",
      title: "Evidence",
      text: corpus,
    })
    const proposed = await store.facts.add({
      type: "statement",
      statement: "The sender reported a delivery",
      project: project.ref,
      by: { bot: "synthetic-reviewer", model: "synthetic-model" },
      evidence: [document.ref],
    })
    const accepted = await store.facts.add({
      type: "decision",
      statement: "Review before proceeding",
      project: project.ref,
      by: "owner",
      subject: org.ref,
      evidence: [document.ref],
      occurredAt: new Date(at - 1000).toISOString(),
    })
    await store.notes.addLink({
      from: document.ref,
      to: project.ref,
      kind: "related-to",
      role: "key",
      origin: "suggested",
      confirmed: false,
      evidence: "Research background",
      provenance: "synthetic suggestion",
    })
    const db = await openCache(path)
    return {
      directory,
      path,
      at,
      store,
      db,
      project,
      org,
      document,
      proposed,
      accepted,
      corpus,
      close: async () => {
        db.close()
        await store.close()
      },
    }
  } catch (error) {
    await store.close()
    throw error
  }
}
