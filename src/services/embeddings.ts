import type { ServiceDeps } from "./deps.js"
import type { EmbeddingsService } from "./embedding-contracts.js"
import { embeddingRuntime } from "./embedding-runtime.js"
import { embeddingsMaintenanceService } from "./embeddings-maintenance.js"
import { embeddingsSearchService } from "./embeddings-search.js"

export * from "./embedding-contracts.js"
export { vectorModelKey } from "./embedding-runtime.js"
export { REFRESH_BOUNDS } from "./embeddings-maintenance.js"

export const embeddingsService = (deps: ServiceDeps): EmbeddingsService => {
  const runtime = embeddingRuntime(deps)
  const maintenance = embeddingsMaintenanceService(deps, runtime)
  return { ...maintenance, ...embeddingsSearchService(deps, runtime, maintenance) }
}
