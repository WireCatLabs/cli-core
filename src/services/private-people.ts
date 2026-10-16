import type * as v from "valibot"
import { formatReference } from "../domain/references.js"
import type { contactNote } from "../entities/contact-note.js"
import { pickPerson } from "../resolve.js"
import type { PrivateContactNote } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"

export type ContactNoteItem = v.InferOutput<typeof contactNote>

const noteItem = (provider: string, note: PrivateContactNote): ContactNoteItem => ({
  id: note.id,
  contact: formatReference({ type: "contact", provider, id: note.personId }),
  text: note.text,
  revision: note.revision,
  created_at: note.createdAt,
  updated_at: note.updatedAt,
})

export const privatePeopleService = (deps: ServiceDeps) => {
  const target = async (reference: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const person = pickPerson(reference, await store.people.people(account.provider, { account: account.account }))
    return { store, account, person }
  }
  return {
    notes: async (reference: string) => {
      const { store, account, person } = await target(reference)
      return (await store.people.privateContact(account, person.id)).notes.map((note) =>
        noteItem(account.provider, note),
      )
    },
    alias: async (reference: string, alias: string | null) => {
      const { store, account, person } = await target(reference)
      return store.people.setContactAlias(account, person.id, alias)
    },
    add: async (reference: string, text: string) => {
      const { store, account, person } = await target(reference)
      return noteItem(account.provider, await store.people.addContactNote(account, person.id, text))
    },
    note: async (reference: string, id: string) => {
      const { store, account, person } = await target(reference)
      return noteItem(account.provider, await store.people.contactNote(account, person.id, id))
    },
    edit: async (reference: string, id: string, text: string, revision: number) => {
      const { store, account, person } = await target(reference)
      return noteItem(account.provider, await store.people.editContactNote(account, person.id, id, text, revision))
    },
    remove: async (reference: string, id: string) => {
      const { store, account, person } = await target(reference)
      return store.people.removeContactNote(account, person.id, id)
    },
  }
}
