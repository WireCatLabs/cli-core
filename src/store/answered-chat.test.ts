import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { answeredChatPk } from "./sqlite/chats.js"
import { openSqlite, type StoreContext } from "./sqlite/open.js"

const live: StoreContext[] = []
afterEach(() => {
  for (const context of live.splice(0)) context.database.close()
})

const opened = async (rows: string) => {
  const context = { ...(await openSqlite(":memory:")), now: () => 5 }
  live.push(context)
  migrate(context.database)
  context.database.exec(`
    INSERT INTO accounts (id,provider,external_id,created_at,updated_at) VALUES (1,'whatsapp','owner',0,0),(2,'whatsapp','other',0,0);
    INSERT INTO chats (id,account_id,external_id,kind,title,searchable,scope,updated_at,created_at) VALUES ${rows};
  `)
  return context
}

const row = (context: StoreContext, pk: number) =>
  context.database
    .prepare("SELECT account_id, external_id, kind, title, searchable, scope FROM chats WHERE id=?")
    .get(pk)

describe("the chat row a send lands in when the messenger answered another id", () => {
  it("is made with the typed row's title, kind and privacy", async () => {
    const context = await opened("(1,1,'phone','dialog','Olga',0,'personal',0,0)")

    const pk = answeredChatPk(context, 1, "lid", "phone")

    expect(row(context, pk)).toEqual({
      account_id: 1,
      external_id: "lid",
      kind: "dialog",
      title: "Olga",
      searchable: 0,
      scope: "personal",
    })
  })

  it("already there, is hidden from search when the typed row is", async () => {
    const context = await opened("(1,1,'phone','dialog','Olga',0,NULL,0,0),(2,1,'lid','dialog','Olga L',1,NULL,0,0)")

    expect(row(context, answeredChatPk(context, 1, "lid", "phone"))).toMatchObject({ title: "Olga L", searchable: 0 })
  })

  it("already there and hidden, stays hidden when the typed row is not", async () => {
    const context = await opened("(1,1,'phone','dialog','Olga',1,NULL,0,0),(2,1,'lid','dialog','Olga L',0,NULL,0,0)")

    expect(row(context, answeredChatPk(context, 1, "lid", "phone"))).toMatchObject({ searchable: 0 })
  })

  it("already there, turns personal when it and the typed row sit on different sides", async () => {
    const context = await opened(
      "(1,1,'phone','dialog','Olga',1,'personal',0,0),(2,1,'lid','dialog','Olga L',1,'work',0,0)",
    )

    expect(row(context, answeredChatPk(context, 1, "lid", "phone"))).toMatchObject({ scope: "personal" })
  })

  it("takes nothing from another account's row with the typed id", async () => {
    const context = await opened("(1,2,'phone','dialog','Olga',0,'personal',0,0)")

    expect(row(context, answeredChatPk(context, 1, "lid", "phone"))).toMatchObject({
      account_id: 1,
      kind: "unknown",
      title: null,
    })
  })
})
