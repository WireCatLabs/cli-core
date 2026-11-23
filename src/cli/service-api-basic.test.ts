import { expect, it, vi } from "vitest"
import type { ServiceApiManifest } from "./service-api-manifest.js"
import { signRequest } from "./service-api-manifest.js"

// A cli-base that signs Basic itself, as cli-base #643 makes it: cli-core's own rules must still hold over it.
vi.mock("@wirecat/cli-base/codegen/runtime", async (original) => {
  const real = await original<typeof import("@wirecat/cli-base/codegen/runtime")>()
  return {
    ...real,
    signInPlace: (scheme: Parameters<typeof real.signInPlace>[0]) =>
      scheme.type === "http" && /^basic$/i.test(scheme.scheme ?? "")
        ? {
            in: "header",
            name: "authorization",
            value: (token: string) => `Basic ${Buffer.from(token).toString("base64")}`,
            basic: true,
          }
        : real.signInPlace(scheme),
  }
})

const manifest = (security: ServiceApiManifest["security"]) =>
  ({
    servers: [{ url: "https://blog.example/wp-json" }],
    securitySchemes: { basic: { type: "http", scheme: "basic" }, bearer: { type: "http", scheme: "bearer" } },
    security,
    operations: [
      {
        id: "listPosts",
        command: "list-posts",
        effect: "read",
        binding: { kind: "http", method: "GET", path: "/posts" },
        parameters: [],
      },
    ],
  }) as unknown as ServiceApiManifest

const signed = async (one: ServiceApiManifest, token: string) => {
  const request = { url: new URL("https://blog.example/wp-json/posts"), headers: new Headers() }
  await signRequest(one, one.operations[0] as never, request, () => token)
  return request.headers.get("authorization")
}

it("over a cli-base that signs Basic, a token scheme still goes first and a token without a user name is refused", async () => {
  expect(await signed(manifest([{ basic: [] }, { bearer: [] }]), "token-a")).toBe("Bearer token-a")
  await expect(signed(manifest([{ basic: [] }]), "token-a")).rejects.toThrow("session start --login <name>")
  expect(await signed(manifest([{ basic: [] }]), "editor:pw")).toBe(
    `Basic ${Buffer.from("editor:pw").toString("base64")}`,
  )
})
