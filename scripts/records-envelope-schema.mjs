// Writes schemas/records-envelope.v1.schema.json from the record registry, as built into dist.
import { writeFileSync } from "node:fs"
import { RECORDS_ENVELOPE_SCHEMA } from "../dist/domain/records.js"

writeFileSync(
  new URL("../schemas/records-envelope.v1.schema.json", import.meta.url),
  `${JSON.stringify(RECORDS_ENVELOPE_SCHEMA, null, 2)}\n`,
)
