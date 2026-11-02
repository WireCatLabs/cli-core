import { describe, expect, it } from "vitest"
import { chatReferenceOf, contactReferenceOf, ensureAccount, wrongAccount } from "./ref-arguments.js"

describe("references given for a chat, a message or a person", () => {
  it("reads this messenger's chat and message references, and leaves ids and titles alone", () => {
    expect(chatReferenceOf("chat:max/34871122/63488582", "max")).toEqual({
      text: "chat:max/34871122/63488582",
      provider: "max",
      account: "34871122",
      chat: "63488582",
    })
    expect(chatReferenceOf(" msg:max/1/-100/7 ", "max")).toMatchObject({ account: "1", chat: "-100", message: "7" })
    for (const text of ["-1001", "Book club", "Note: plan", "@olga"])
      expect(chatReferenceOf(text, "max")).toBeUndefined()
  })

  it("refuses another kind and another messenger with the command that opens it", () => {
    expect(() => chatReferenceOf("document:413", "max")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "ref.wrong-kind" }),
        message:
          "document:413 names a document; this takes a chat: chat:<provider>/<account>/<chat>, its id or its title",
      }),
    )
    expect(() => chatReferenceOf("chat:telegram/220195113/174942312", "max")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: "ref.wrong-provider" }),
        message:
          "chat:telegram/220195113/174942312 is a Telegram chat; open it with tg <profile> messages list chat:telegram/220195113/174942312",
      }),
    )
    expect(() => chatReferenceOf("chat:max/1", "max")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "ref.malformed" }) }),
    )
  })

  it("names the account a reference belongs to and the profiles that have it", async () => {
    const reference = { text: "chat:max/111/222", account: "111" }
    expect(wrongAccount(reference, { account: "34871122", profile: "default" }, ["work"]).message).toBe(
      "chat:max/111/222 belongs to account 111; profile default is account 34871122. Profiles signed in to 111: work",
    )
    expect(wrongAccount(reference, { account: "34871122" }, []).message).toBe(
      "chat:max/111/222 belongs to account 111; this profile is account 34871122. Profiles signed in to 111: none here",
    )
    await expect(ensureAccount(reference, { account: "111" })).resolves.toBeUndefined()
    await expect(ensureAccount(reference, { account: undefined })).rejects.toMatchObject({
      details: expect.objectContaining({ reason: "ref.wrong-account" }),
      message: "chat:max/111/222 belongs to account 111; the account of this profile is not known yet",
    })
  })

  it("reads a contact reference of this messenger only", () => {
    expect(contactReferenceOf("contact:telegram/101", "telegram")).toBe("101")
    expect(contactReferenceOf("Olga", "telegram")).toBeUndefined()
    expect(() => contactReferenceOf("contact:max/101", "telegram")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "ref.wrong-provider" }) }),
    )
  })
})
