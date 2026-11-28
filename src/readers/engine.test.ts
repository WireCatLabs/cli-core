import { expect, it } from "vitest"
import { EngineUnavailable } from "../engines/install.js"
import { withEngine } from "./engine.js"

it("**a reader whose engine could not be installed answers engine-missing with the command to retry**", async () => {
  const load = async () => {
    throw new EngineUnavailable({
      status: "engine-missing",
      engine: "unpdf",
      version: "1.0.0",
      reason: "fetch failed",
      retry: "demo documents sync",
    })
  }
  expect(await withEngine(load, "unpdf", async () => ({ status: "unsupported" }))).toEqual({
    status: "engine-missing",
    engine: "unpdf",
    retry: "demo documents sync",
    reason: "fetch failed",
  })
})
