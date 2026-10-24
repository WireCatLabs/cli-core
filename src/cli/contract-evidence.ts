import { CliError } from "@wirecat/cli-base"
import { annotate, describeProgram, flatten } from "@wirecat/cli-base/commands"
import { jsonSchemaOf } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { entityDefinitions } from "../entities/index.js"
import { type AppErrors, failureContext } from "../errors/reasons.js"
import { answerEntitySchema } from "./answer-entity.js"
import { commandContract, findCommand, SCHEMA_DIALECT } from "./command-contract.js"
import { DISCOVERY_DESCRIPTIONS } from "./discovery-descriptions.js"
import { NO_EFFECTS } from "./effects.js"
import type { JsonFieldsResolver } from "./json-fields.js"
import { sharedContractOverrides, sharedContracts } from "./shared-contracts.js"

export interface ContractEvidenceOptions {
  fields?: JsonFieldsResolver
  errors?: AppErrors
}

export const contractEvidence = (root: Command, { fields, errors }: ContractEvidenceOptions = {}) => {
  const schemas: Record<string, unknown> = { ...entityDefinitions() }
  const fieldOnly: string[] = []
  for (const info of flatten(describeProgram(root))) {
    if (!info.output) continue
    const name = info.output.view ? `${info.output.entity}.${info.output.view}` : info.output.entity
    const command = findCommand(root, info.path)
    const schema = answerEntitySchema(command)
    if (schema) schemas[name] = jsonSchemaOf(schema)
    else if (schemas[name] === undefined) {
      const names = fields?.(command)
      if (names) {
        schemas[name] = {
          type: "object",
          properties: Object.fromEntries(names.map((name) => [name, {}])),
          additionalProperties: false,
        }
        fieldOnly.push(name)
      }
    }
  }
  return {
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [name, { $schema: SCHEMA_DIALECT, ...(schema as object) }]),
    ),
    contracts: sharedContracts(root),
    field_only: [...new Set(fieldOnly)].sort(),
    reasons: failureContext(errors).reasons,
    overrides: sharedContractOverrides(root),
  }
}

/** Same discovery endpoint for the shared runner and providers with their own output/context adapters. */
export const addContractInfo = (
  root: Command,
  output: (value: unknown) => void,
  options: ContractEvidenceOptions = {},
) => {
  const commands = root.commands.find((command) => command.name() === "commands")
  if (!commands) throw new CliError("configuration_error", "contract discovery needs the commands group")
  const info = commands.commands.find((command) => command.name() === "info") ?? commands.command("info")
  annotate(info, { effects: NO_EFFECTS, examples: [`${root.name()} commands info --json`] })
  if (info.registeredArguments.length === 0)
    info.argument("[path...]", "one command path; without one, schemas, error reasons and explicit overrides")
  if (
    !info.options.some((option) => option.long === "--json") &&
    !root.options.some((option) => option.long === "--json")
  )
    info.option("--json", "print JSON")
  info
    .description(DISCOVERY_DESCRIPTIONS.info)
    .action((path: string[]) =>
      output(path.length ? commandContract(findCommand(root, path)) : contractEvidence(root, options)),
    )
  return info
}
