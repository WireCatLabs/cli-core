import { c, del, fk, id, ts } from "./columns.mjs"
import { MINOR, reviewed } from "./finance.mjs"

export const crmTables = [
  {
    name: "pipelines",
    doc: "A sales pipeline of the owner's: the stages a deal goes through, in order. Only the owner makes one.",
    cols: [
      id(),
      c("name", "text", { notnull: true, note: "as the owner typed it" }),
      c("name_folded", "text", { notnull: true, unique: true, note: "the name in one letter case: one per owner" }),
      ...ts(),
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
      c("position", "integer", { notnull: true, note: "1, 2, …: the order a deal goes through them" }),
      ...ts(),
    ],
    keys: ["UNIQUE (pipeline_id, name_folded)", "UNIQUE (pipeline_id, position)"],
  },
  {
    name: "opportunities",
    doc: "A deal (`deal:<id>`): what the owner hopes to sell, to whom, where it stands in its pipeline and whether it ended. The people on it are `links` (kind `related-to`, `role` owner, contact or decision-maker). A deal is not a project.",
    cols: [
      id(),
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
      ...reviewed(),
      ...ts(),
      del(),
    ],
  },
]
