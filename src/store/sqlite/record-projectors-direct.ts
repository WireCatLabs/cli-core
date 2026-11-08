import type { CatalogKind, WalletKind } from "../../domain/business.js"
import type { CrmItem } from "../../domain/crm.js"
import type { DealKind, DealStatus, StageOutcome } from "../../domain/deals.js"
import { authorActor } from "./memories.js"
import { requiredThing } from "./notes.js"
import {
  given,
  IMPORTER,
  oneOf,
  type Projection,
  type ProjectionTools,
  type RecordProjector,
  type Row,
  refusal,
  written,
} from "./record-projection.js"

const productFields = (fields: Row) => ({
  name: given<string>(fields, "name") as string,
  unit: given<string>(fields, "unit"),
  unitPrice: given<string>(fields, "unit_price"),
  currency: given<string>(fields, "currency"),
  description: given<string>(fields, "description"),
})

const pipelineOf = (projection: Projection) => {
  const { fields, externalId } = projection
  const stages = (fields.stages as Row[]).map((stage, index) => ({
    externalId: String(stage.external_id),
    name: String(stage.name),
    position: typeof stage.position === "number" ? stage.position : index + 1,
    outcome: (given<StageOutcome>(stage, "outcome") ?? "open") as StageOutcome,
  }))
  return { externalId, name: String(fields.name), stages }
}

const idOf = (ref: string | undefined, { context }: ProjectionTools): number | null | undefined =>
  ref === undefined ? undefined : requiredThing(context.database, ref).id

/** A deal or a lead on the row of `(account, external id)`: the one CRM sync writes for the same account. */
const saveDeal = (kind: DealKind) => (projection: Projection, tools: ProjectionTools) => {
  const { fields, externalId, source, accountId } = projection
  const item: CrmItem = {
    externalId,
    title: String(fields.title),
    pipeline: String(fields.pipeline),
    stage: String(fields.stage),
    status: given<DealStatus>(fields, "status"),
    amount: given<string>(fields, "amount"),
    currency: given<string>(fields, "currency"),
    closeDate: given<string>(fields, "close_date"),
    closedDate: given<string>(fields, "closed_date"),
    closedReason: given<string>(fields, "closed_reason"),
    url: given<string>(fields, "url"),
  }
  const saved = tools.crm.saveItemRow(source, accountId, kind, item, tools.context.now(), {
    organization: idOf(oneOf(projection, "organization"), tools) ?? null,
    // Left out, the project stays: the owner may have set one on the deal here.
    project: idOf(oneOf(projection, "project"), tools),
    ...(kind === "lead" ? { deal: idOf(oneOf(projection, "deal"), tools) ?? null } : {}),
    author: authorActor(tools.context, IMPORTER).actor,
    source: written(source).source,
  })
  if ("reason" in saved) return refusal(saved.message, "record.reference-not-found", ["fields", "stage"])
  return `${kind}:${saved.id}`
}

const dealProjector = (kind: DealKind): RecordProjector => {
  const save = saveDeal(kind)
  return {
    create: save,
    update: (_ref, projection, tools) => {
      save(projection, tools)
      return true
    },
  }
}

export const DIRECT_PROJECTORS = {
  product: {
    create: ({ fields, source, related }, { products }) => {
      const made = products.add({
        ...productFields(fields),
        by: IMPORTER,
        kind: given<CatalogKind>(fields, "kind"),
        sku: given<string>(fields, "sku"),
        supplier: related.get("supplier")?.[0],
        source: written(source).source,
      })
      const archived = given<string>(fields, "archived_date")
      if (archived !== undefined) products.update(made.ref, { by: IMPORTER, archivedDate: archived })
      return made.ref
    },
    update: (ref, { fields }, { products }) => {
      const { name, unit, unitPrice, currency, description } = productFields(fields)
      products.update(ref, {
        by: IMPORTER,
        name,
        unit: unit ?? null,
        unitPrice: unitPrice ?? null,
        currency: currency ?? null,
        description: description ?? null,
        archivedDate: given<string>(fields, "archived_date") ?? null,
      })
      return true
    },
  },
  wallet: {
    // The opening balance stays in the record: only the owner sets the wallet's.
    create: ({ fields, source, related }, { wallets }) =>
      wallets.add({
        by: IMPORTER,
        name: String(fields.name),
        currency: String(fields.currency),
        kind: given<WalletKind>(fields, "kind"),
        institution: given<string>(fields, "institution"),
        numberHint: given<string>(fields, "number_hint"),
        holder: related.get("holder")?.[0],
        source: written(source).source,
      }).ref,
    update: (ref, { fields }, { wallets }) => {
      wallets.update(ref, {
        by: IMPORTER,
        name: String(fields.name),
        institution: given<string>(fields, "institution") ?? null,
        numberHint: given<string>(fields, "number_hint") ?? null,
      })
      return true
    },
  },
  pipeline: {
    create: (projection, { crm, context }) => {
      const kind = given<DealKind>(projection.fields, "kind") ?? "deal"
      return `pipeline:${crm.savePipeline(projection.accountId, kind, pipelineOf(projection), context.now())}`
    },
    update: (_ref, projection, { crm, context }) => {
      const kind = given<DealKind>(projection.fields, "kind") ?? "deal"
      crm.savePipeline(projection.accountId, kind, pipelineOf(projection), context.now())
      return true
    },
  },
  deal: dealProjector("deal"),
  lead: dealProjector("lead"),
} as const satisfies Record<string, RecordProjector>
