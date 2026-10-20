import { rmSync } from "node:fs"
import { dirname } from "node:path"
import { expect, it } from "vitest"
import { contextEvidenceFixture } from "../../testing/context-evidence.js"
import { snapshotProjectAnnotations } from "./snapshot.js"

it("fingerprints cited source kinds without copying their text or unrelated project records", async () => {
  const f = await contextEvidenceFixture()
  try {
    const project = await f.store.knowledge.addProject({ name: "Snapshot Example", key: "SNP" })
    const note = await f.store.knowledge.addAnnotation(null, { type: "project", id: project.id }, "Invented note")
    const transcript = f.saved.transcripts[0]
    if (!transcript) throw new Error("Missing synthetic transcript")
    const refs = [
      "msg:example-calendar/AliceExample/planning/1",
      "msg:email/example-mail/thread/letter",
      f.doc.ref,
      `note:${note.id}`,
      f.reference,
      `${f.reference}/${transcript.transcript.id}`,
      `${f.reference}/${transcript.transcript.id}/0`,
    ] as const
    await f.store.facts.add({
      type: "statement",
      statement: "Review the cited examples",
      project: project.ref,
      by: "owner",
      evidence: [...refs],
    })
    const result = await snapshotProjectAnnotations({ source: f.path, project: project.ref })
    expect(result.snapshot.facts).toHaveLength(1)
    for (const ref of refs)
      expect(result.snapshot.external.find((e) => e.ref === ref)?.content_sha256).toMatch(/^[a-f0-9]{64}$/)
    const json = JSON.stringify(result.snapshot)
    for (const body of ["Invented note", "Launch agreement", "Launch checklist", "Ship the example plan."])
      expect(json).not.toContain(body)
    expect(result.snapshot.coverage).toMatchObject({ notes: "omitted", meeting_memberships: "omitted" })
    const hashes = () =>
      snapshotProjectAnnotations({ source: f.path, project: project.ref }).then(
        (r) => new Map(r.snapshot.external.map((e) => [e.ref, e.content_sha256])),
      )
    const initial = await hashes()
    f.db
      .prepare("UPDATE meeting_transcript_rows SET text='A revised invented passage' WHERE meeting_transcript_id=?")
      .run(transcript.transcript.id)
    const revised = await hashes()
    expect(revised.get(refs[5])).not.toBe(initial.get(refs[5]))
    expect(revised.get(refs[6])).not.toBe(initial.get(refs[6]))
    for (const ref of refs.slice(0, 5)) expect(revised.get(ref)).toBe(initial.get(ref))
    f.db.prepare("UPDATE meetings SET deleted_at=6000 WHERE id=?").run(f.saved.meeting.id)
    await expect(snapshotProjectAnnotations({ source: f.path, project: project.ref })).rejects.toMatchObject({
      code: "configuration_error",
    })
  } finally {
    await f.close()
    rmSync(dirname(f.path), { recursive: true, force: true })
  }
})
