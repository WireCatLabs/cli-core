import { describe, expect, it } from "vitest"
import { linkFetch } from "./link-fetch.js"

describe("linkFetch", () => {
  const reached: string[] = []
  const links = linkFetch({
    hosts: ["downloader.disk.yandex.ru", "*.disk.yandex.net"],
    fetch: async (input) => {
      reached.push(String(input))
      return new Response("bytes")
    },
  })

  it("fetches a returned link on a listed host, without the sign-in", async () => {
    expect(await (await links("https://downloader.disk.yandex.ru/disk/abc?sign=x")).text()).toBe("bytes")
    expect(reached).toEqual(["https://downloader.disk.yandex.ru/disk/abc?sign=x"])
  })

  it("refuses the sign-in, a host off the list and plain http before anything leaves", async () => {
    reached.length = 0
    await expect(
      links("https://uploader1.disk.yandex.net/upload", { headers: { Authorization: "OAuth token" } }),
    ).rejects.toMatchObject({ code: "configuration_error", details: { sent: false } })
    await expect(links("https://cookie.disk.yandex.net/", { headers: { cookie: "a=b" } })).rejects.toMatchObject({
      details: { sent: false },
    })
    await expect(links("https://evil.test/file")).rejects.toMatchObject({ details: { sent: false } })
    await expect(links("http://downloader.disk.yandex.ru/file")).rejects.toMatchObject({ code: "validation_error" })
    expect(reached).toEqual([])
  })

  it("refuses a Request that carries the sign-in, a service's own key header, and a redirect off the list", async () => {
    reached.length = 0
    const request = new Request("https://downloader.disk.yandex.ru/f", { headers: { authorization: "Bearer t" } })
    await expect(links(request)).rejects.toMatchObject({ details: { sent: false } })
    const keyed = linkFetch({
      hosts: ["files.test"],
      signIn: ["X-Api-Key"],
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.test/f" } }),
    })
    await expect(keyed("https://files.test/f", { headers: { "x-api-key": "k" } })).rejects.toMatchObject({
      details: { sent: false },
    })
    await expect(keyed("https://files.test/f")).rejects.toThrow("evil.test is not a host")
    expect(reached).toEqual([])
  })
})
