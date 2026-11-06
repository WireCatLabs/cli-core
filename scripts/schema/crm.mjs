import { c, del, fk, id, ts } from "./columns.mjs"
import { MINOR, reviewed } from "./finance.mjs"

export const crmTables = [
  {
    name: "pipelines",
    doc: "A sales pipeline: the stages a deal or a lead goes through, in order. The owner makes his own; a CRM sync copies an account's.",
    cols: [
      id(),
      fk("account_id", "accounts", { note: "the CRM account it was copied from; null for the owner's own" }),
      c("external_id", "text", { note: "the pipeline's id in that CRM" }),
      c("kind", "text", { notnull: true, note: "deal or lead: what its stages hold" }),
      c("name", "text", { notnull: true, note: "as the owner or the CRM wrote it" }),
      c("name_folded", "text", {
        notnull: true,
        note: "the name in one letter case: one per kind among the owner's own, any among a CRM's",
      }),
      ...ts(),
    ],
    keys: [
      "UNIQUE (account_id, external_id) WHERE account_id IS NOT NULL AND external_id IS NOT NULL",
      "UNIQUE (name_folded, kind) WHERE account_id IS NULL",
    ],
  },
  {
    name: "pipeline_stages",
    doc: "One stage of a pipeline, such as a first call or a sent quote.",
    cols: [
      id(),
      fk("pipeline_id", "pipelines", { notnull: true }),
      c("name", "text", { notnull: true }),
      c("name_folded", "text", { notnull: true, note: "the name in one letter case, unique in its pipeline" }),
      c("position", "integer", {
        notnull: true,
        note: "1, 2, …: the order a deal goes through them; not unique, so a sync or a reorder can swap two",
      }),
      c("outcome", "text", { notnull: true, note: "open, won, lost: a CRM marks the stages that end a deal" }),
      c("external_id", "text", { note: "the stage's id in its pipeline's CRM" }),
      ...ts(),
    ],
    keys: [
      "UNIQUE (pipeline_id, name_folded)",
      "UNIQUE (pipeline_id, external_id) WHERE external_id IS NOT NULL",
      "INDEX (pipeline_id, position)",
    ],
  },
  {
    name: "opportunities",
    doc: "A deal (`deal:<id>`) or a lead (`lead:<id>`): what the owner hopes to sell, to whom, where it stands in its pipeline and whether it ended. The people on it are `links` (kind `related-to`, `role` owner, contact or decision-maker). A deal is not a project.",
    cols: [
      id(),
      c("kind", "text", { notnull: true, note: "deal or lead, as its stage's pipeline is" }),
      c("title", "text", { notnull: true }),
      fk("organization_id", "organizations"),
      fk("project_id", "projects"),
      fk("stage_id", "pipeline_stages", {
        notnull: true,
        note: "where it stands; a closed deal keeps its last stage, and a deal moves only within its pipeline",
      }),
      c("status", "text", { notnull: true, note: "open, won, lost: kept apart from the stage" }),
      c("currency", "text", { note: "ISO 4217, upper case; set with `amount` or not at all" }),
      c("amount", "integer", { note: `the expected amount, ${MINOR}` }),
      c("close_date", "text", { note: "`YYYY-MM-DD`: the day it is expected to close" }),
      c("closed_date", "text", { note: "`YYYY-MM-DD`: the day it was won or lost" }),
      c("rank", "real", { note: "its order in its stage's column on a board, lowest first; null sorts last" }),
      ...reviewed(),
      ...ts(),
      del(),
    ],
  },
]
