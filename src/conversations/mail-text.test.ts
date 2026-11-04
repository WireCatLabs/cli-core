import { describe, expect, it } from "vitest"
import { mailCore, mailOwnText } from "./mail-text.js"

const first =
  "Hi Bob,\n\nThe invoice for March is attached. Please pay by Friday.\n\nBest regards,\nAlice Example\nACME Ltd"

describe("mailCore", () => {
  it("drops the greeting and the sign-off with the name under it", () => {
    expect(mailCore(first, [])).toBe("The invoice for March is attached. Please pay by Friday.")
  })

  it("drops a quote of an earlier email with its attribution line", () => {
    const reply = [
      "Paid today, thanks.",
      "",
      "On Mon, 3 Mar 2026 at 10:00, Alice Example <alice@example.com> wrote:",
      ...first.split("\n").map((line) => `> ${line}`),
    ].join("\n")
    expect(mailCore(reply, [first])).toBe("Paid today, thanks.")
  })

  it("keeps a quote of mail the thread does not hold", () => {
    const reply = "See below.\n\nOn Mon, Carol Sample wrote:\n> The venue moved to Hall B."
    expect(mailCore(reply, [first])).toContain("> The venue moved to Hall B.")
  })

  it("matches a quote rewrapped by the replying client", () => {
    const rewrapped = "Done.\n\nAlice wrote:\n> The invoice for March is attached.\n> Please pay by\n> Friday."
    expect(mailCore(rewrapped, ["The invoice for March is attached. Please pay by Friday."])).toBe("Done.")
  })

  it("drops an Outlook original-message block it already holds", () => {
    const reply = `Confirmed.\n\n-----Original Message-----\nFrom: Alice Example\nSent: Monday\n\n${first}`
    expect(mailCore(reply, [first])).toBe("Confirmed.")
  })

  it("cuts at the signature separator and drops 'Sent from my phone'", () => {
    expect(mailCore("Works for me.\nSent from my iPhone\n-- \nBob Sample\n+1 555 0100", [])).toBe("Works for me.")
  })

  it("keeps a closing line that carries content", () => {
    expect(mailCore("Thanks for the quick fix, it works now.", [])).toBe("Thanks for the quick fix, it works now.")
  })

  it("strips Russian and Spanish greetings and sign-offs", () => {
    expect(mailCore("Добрый день!\n\nДоговор подписан.\n\nС уважением,\nИван", [])).toBe("Договор подписан.")
    expect(mailCore("Hola Ana,\n\nLa reunión es el lunes.\n\nUn saludo,\nLuis", [])).toBe("La reunión es el lunes.")
  })

  it("keeps a greeting line that goes on with the message", () => {
    expect(mailCore("Hi Bob, can you send the report today?", [])).toBe("Hi Bob, can you send the report today?")
    expect(mailCore("Здравствуйте, Иван Петров. Вы получили:\n- счёт", [])).toContain("Вы получили:")
  })

  it("keeps the text after a bare -- divider, which newsletters use between sections", () => {
    const issue = "Top story: the venue moved.\n--\nSecond story: the budget doubled for the offsite."
    expect(mailCore(issue, [])).toBe(issue)
  })

  it("keeps a postscript, a question or a sentence after the sign-off", () => {
    expect(mailCore("See you there.\n\nThanks,\nAlice\nP.S. the room is now B12", [])).toContain("P.S. the room")
    expect(mailCore("See you there.\n\nCheers,\nAlice\nCan you bring the cables?", [])).toContain("bring the cables")
  })
})

describe("mailOwnText", () => {
  const quote = (text: string) => text.split("\n").map((line) => `> ${line}`)
  const reply = (own: string, ...rest: string[]) => [own, "", ...rest].join("\n")

  it.each([
    ["en", "On Mon, 3 Nov 2026 at 10:00, Alice Example <alice@example.com> wrote:"],
    ["ru", "пн, 3 нояб. 2026 г. в 10:00, Иван Петров <ivan@example.com>:"],
    ["ru", "3 ноября 2026 г., в 10:00, Иван Петров написал(а):"],
    ["es", "El lun, 3 nov 2026 a las 10:00, Ana Ejemplo (<ana@example.com>) escribió:"],
    ["de", "Am Mo., 3. Nov. 2026 um 10:00 Uhr schrieb Max Beispiel <max@example.com>:"],
    ["fr", "Le lun. 3 nov. 2026 à 10:00, Claire Exemple <claire@example.com> a écrit :"],
  ])("drops a %s reply header with the quote under it", (_, header) => {
    expect(mailOwnText(reply("Paid today.", header, ...quote(first)))).toBe("Paid today.")
  })

  it("cuts at a reply header the client wrapped and did not quote, as HTML mail turned to text reads", () => {
    const body = reply(
      "Paid today.",
      "On Mon, 3 Nov 2026 at 10:00, Alice Example <",
      "alice@example.com> wrote:",
      first,
    )
    expect(mailOwnText(body)).toBe("Paid today.")
  })

  it("keeps answers written between quoted lines", () => {
    const body = ["Alice wrote:", "> Can you pay by Friday?", "Yes, on Thursday.", "> And the March one?", "Paid."]
    expect(mailOwnText(body.join("\n"))).toBe("Yes, on Thursday.\nPaid.")
  })

  it.each([
    ["en", "From: Alice Example <alice@example.com>\nSent: Monday, 3 November 2026 10:00\nTo: Bob\nSubject: Invoice"],
    ["de", "Von: Max Beispiel <max@example.com>\nGesendet: Montag, 3. November 2026 10:00\nAn: Bob\nBetreff: Rechnung"],
    ["fr", "De : Claire Exemple <claire@example.com>\nEnvoyé : lundi 3 novembre 2026 10:00\nÀ : Bob\nObjet : Facture"],
    [
      "es",
      "De: Ana Ejemplo <ana@example.com>\nEnviado: lunes, 3 de noviembre de 2026 10:00\nPara: Bob\nAsunto: Factura",
    ],
    ["ru", "От: Иван Петров <ivan@example.com>\nОтправлено: 3 ноября 2026 г. 10:00\nКому: Bob\nТема: Счёт"],
  ])("cuts a %s Outlook header and its divider with everything under it", (_, header) => {
    expect(mailOwnText(reply("Confirmed.", "________________________________", header, "", first))).toBe("Confirmed.")
  })

  it("cuts at an Original Message divider", () => {
    expect(
      mailOwnText(reply("Confirmed.", "-----Original Message-----", "From: Alice", "Sent: Monday", "", first)),
    ).toBe("Confirmed.")
  })

  it("drops the signature after the -- delimiter and a mobile footer", () => {
    expect(mailOwnText("Works for me.\n\nVon meinem iPhone gesendet\n-- \nBob Sample\n+1 555 0100")).toBe(
      "Works for me.",
    )
  })

  it("keeps a forwarded message whole", () => {
    const body = reply(
      "FYI, see below.",
      "---------- Forwarded message ---------",
      "From: Alice <alice@example.com>",
      "Date: Mon, 3 Nov 2026",
      "",
      first,
    )
    expect(mailOwnText(body)).toBe(body)
  })

  it("keeps the whole body when the email is only a quote", () => {
    const body = ["On Mon, 3 Nov 2026, Alice Example <alice@example.com> wrote:", ...quote(first)].join("\n")
    expect(mailOwnText(body)).toBe(body)
  })

  it("keeps a paragraph that only mentions what someone wrote", () => {
    const body =
      "Here is what Bob wrote:\nthe venue moved to Hall B.\n\nAlice wrote: the budget is fine.\n" +
      "Questions go to <desk@example.com>:\nwe answer within a day."
    expect(mailOwnText(body)).toBe(body)
  })
})
