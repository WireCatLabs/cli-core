import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES, MEMORY_SCOPES } from "../../domain/knowledge.js"
import { LINK_KINDS } from "../sqlite/link-kinds.js"

const text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max))
const ref = text(2048)
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
const nullableRef = v.nullable(ref)
const bounded = <T extends v.GenericSchema>(schema: T) => v.pipe(v.array(schema), v.maxLength(1000))

export const projectAnnotationsSchema = v.strictObject({
  format: v.literal("wirecat.project-annotations"),
  version: v.literal(1),
  project: v.strictObject({
    ref,
    key: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]{2,3}$/)),
    name: text(200),
    type: v.picklist(["work", "client", "personal", "oss", "other"]),
    scope: v.picklist(MEMORY_SCOPES),
    organization: nullableRef,
    created_at: timestamp,
  }),
  coverage: v.strictObject({
    aliases: v.literal("complete"),
    facts: v.literal("complete"),
    links: v.literal("complete"),
    memories: v.literal("omitted"),
    tasks: v.literal("omitted"),
    labels: v.literal("omitted"),
    findings: v.literal("omitted"),
  }),
  aliases: bounded(text(200)),
  facts: bounded(
    v.strictObject({
      ref,
      type: v.picklist(FACT_TYPES),
      statement: text(2000),
      status: v.picklist(FACT_STATUSES),
      subject: nullableRef,
      occurred_at: v.nullable(timestamp),
      supersedes: nullableRef,
      author: ref,
      model: v.nullable(text(200)),
      confirmed_by: nullableRef,
      scope: v.nullable(v.picklist(MEMORY_SCOPES)),
      source: text(200),
      created_at: timestamp,
      updated_at: timestamp,
    }),
  ),
  links: bounded(
    v.strictObject({
      ref: text(200),
      from: ref,
      to: ref,
      kind: v.picklist(LINK_KINDS),
      role: v.nullable(text(200)),
      evidence: nullableRef,
      confirmed: v.boolean(),
      provenance: v.nullable(text(2000)),
      created_at: timestamp,
    }),
  ),
  external: bounded(
    v.strictObject({
      ref,
      content_sha256: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
    }),
  ),
})

export type ProjectAnnotations = v.InferOutput<typeof projectAnnotationsSchema>
