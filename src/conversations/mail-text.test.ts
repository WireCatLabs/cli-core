import { describe, expect, it } from "vitest"
import { mailCore } from "./mail-text.js"

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
})
