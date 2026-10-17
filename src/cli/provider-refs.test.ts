import { describe, expect, it } from "vitest"
import { answered } from "../mcp/tool.js"
import { itemOf, jsonlRecords, listOf, sealed, snakeKeys } from "./envelope.js"
import { withoutProviderRefs } from "./provider-refs.js"

const SECRET = "media-key-LEAK-SENTINEL"
const message = {
  id: "1",
  attachments: [{ kind: "photo", providerRef: { mediaKey: SECRET } }],
  replyTo: { id: "0", attachments: [{ kind: "video", providerRef: { mediaKey: SECRET } }] },
}

describe("withoutProviderRefs", () => {
  it("**SEC-54: no envelope — CLI item, list, JSON lines or MCP answer — carries a providerRef at any depth**", () => {
    const bodies = [
      sealed(itemOf({ message })),
      sealed(itemOf(snakeKeys({ message }) as object)),
      sealed(listOf("messages list", { items: [message], limit: 1, has_more: false })),
      ...jsonlRecords(listOf("messages list", { items: [message], limit: 1, has_more: false })),
      answered(itemOf({ operation_id: "x", message })),
    ]
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain(SECRET)
    expect(bodies.filter((body) => JSON.stringify(body).includes('"kind":"photo"'))).toHaveLength(5)
  })

  it("leaves what is not a plain object as it is", () => {
    const at = new Date(0)
    expect(withoutProviderRefs({ at, list: [1, "a", null] })).toEqual({ at, list: [1, "a", null] })
  })
})
