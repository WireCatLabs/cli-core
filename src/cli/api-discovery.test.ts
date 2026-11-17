import { describe, expect, it } from "vitest"
import { linkedApiRoot } from "./api-discovery.js"

const API = "https://api.w.org/"
const site = (link: string | null) => async () => new Response(null, { headers: link === null ? {} : { link } })

describe("linkedApiRoot", () => {
  it("reads the API root a WordPress site names, pretty permalinks or not", async () => {
    const both = '<https://a.blog.test/wp-json/>; rel="https://api.w.org/", <https://a.blog.test/?p=1>; rel=shortlink'
    expect(await linkedApiRoot("a.blog.test", site(both), API)).toBe("https://a.blog.test/wp-json/")
    const plain = '<https://a.blog.test/news/?rest_route=/>; rel="https://api.w.org/"'
    expect(await linkedApiRoot("a.blog.test/news", site(plain), API)).toBe("https://a.blog.test/news/?rest_route=/")
    expect(await linkedApiRoot("a.blog.test", site(null), API)).toBeUndefined()
  })

  it("refuses an API root on another host", async () => {
    await expect(
      linkedApiRoot("a.blog.test", site('<https://evil.test/wp-json/>; rel="https://api.w.org/"'), API),
    ).rejects.toThrow("names its API on another host, evil.test")
  })
})
