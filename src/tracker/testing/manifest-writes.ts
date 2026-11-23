import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import type { ServiceApiWrite } from "../../cli/service-api.js"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { crmValues } from "../../crm/index.js"
import { FAKE_MANIFEST_TOKEN } from "../../crm/testing/index.js"
import type { TrackerKind } from "../../domain/tracker.js"
import type { ContractCase } from "../../meetings/index.js"
import { parseTrackerManifest } from "../manifest/manifest.js"
import { trackerWriterFromManifest } from "../manifest/writer.js"
import {
  failingOnRefusals,
  type TrackerManifestFake,
  type TrackerManifestFakeOptions,
  trackerManifestFake,
} from "./manifest-fake.js"
import { type TrackerWriteFixture, trackerWriteContract } from "./write-contract.js"

/**
 * A `trackerWriteContract` fixture for a writer built from a manifest's `writes`, over `trackerManifestFake`: the
 * variables of each write are checked against the generated schema (an unknown field, a missing required one), and
 * the fake's `refusals` say why.
 */
export const trackerManifestWriteFixture = (
  manifest: unknown,
  options: TrackerManifestFakeOptions,
): TrackerWriteFixture & { fake: TrackerManifestFake } => {
  const fake = trackerManifestFake(manifest, options)
  const parsed = parseTrackerManifest(manifest, options.api)
  // serviceApiCall sends reads only; through it a write is built and signed as the CLI's serviceApiWriter builds it,
  // without the profile's guard, which the tracker writes hold above the writer.
  const call = serviceApiCall({
    manifest: { ...options.api, operations: options.api.operations.map((one) => ({ ...one, effect: "read" })) },
    service: parsed.provider,
    fetch: fake.fetch,
    token: () => FAKE_MANIFEST_TOKEN,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  })
  const writeOperations = new Set(
    Object.values(parsed.writes ?? {}).flatMap((one) =>
      [one?.create, one?.update].flatMap((sent) => (sent ? [sent.operation] : [])),
    ),
  )
  let lose = false
  const write: ServiceApiWrite = async (_command, operation, input) => {
    const result = await call(operation, input)
    if (lose) {
      lose = false
      throw new CliError("outcome_unknown", "the connection dropped after the tracker got the write")
    }
    return { operation_id: `fake-${fake.calls.length}`, result }
  }
  const idOf = (kind: TrackerKind) => {
    const row = fake.rows[kind]?.[0]
    const rule = parsed.entities[kind]?.map.externalId
    const id = row && typeof rule === "string" ? crmValues.id(row[rule]) : null
    if (id === null) throw new Error(`the fake holds no ${kind} to write with`)
    return id
  }
  return {
    writer: trackerWriterFromManifest(manifest, { api: options.api, write, command: new Command("fake") }),
    fake,
    team: idOf("team"),
    state: idOf("state"),
    user: idOf("user"),
    label: idOf("label"),
    project: idOf("project"),
    loseNextAnswer: () => {
      lose = true
    },
    requests: () => fake.calls.filter((one) => one.operation && writeOperations.has(one.operation)).length,
  }
}

/**
 * `trackerWriteContract` over `trackerManifestWriteFixture`, each case failing too when the fake refused a call: what
 * a generated test runs, `for (const { name, run } of trackerManifestWriteContract(SOURCE, { api, definitions }))`.
 */
export const trackerManifestWriteContract = (
  manifest: unknown,
  options: TrackerManifestFakeOptions,
): ContractCase[] => {
  const fakes: TrackerManifestFake[] = []
  return failingOnRefusals(
    trackerWriteContract(() => {
      const fixture = trackerManifestWriteFixture(manifest, options)
      fakes.push(fixture.fake)
      return fixture
    }),
    fakes,
  )
}
