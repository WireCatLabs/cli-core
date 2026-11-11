import type { KeyringStore } from "@wirecat/cli-base"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import type { AppIdentity } from "../ports/app.js"
import { type AiSetting, sharedModel } from "./ai.js"
import { type ModelSettings, modelTarget } from "./settings.js"
import type { ModelTarget } from "./types.js"

const HOSTED: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
}

export interface PurposeModel {
  target: ModelTarget & { baseUrl: string }
  key: () => string | undefined
  /** The AI model chosen for every tool (`models ai`), not this purpose's own `models.<purpose>`. */
  shared?: AiSetting
}

/**
 * The model a purpose calls: the flag or environment or config `models.<purpose>` (or `models.default`) first, then
 * the shared AI model. `off` stays off; the shared model never replaces an explicit no.
 */
export const purposeModel = (
  settings: { models?: ModelSettings },
  purpose: string,
  deps: { app: AppIdentity; env: NodeJS.ProcessEnv; keyring?: KeyringStore | undefined },
): PurposeModel | undefined => {
  const configured = modelTarget(settings, purpose)
  if (configured) {
    const baseUrl = configured.baseUrl ?? HOSTED[configured.provider] ?? ""
    return {
      target: { ...configured, baseUrl },
      key: () =>
        embeddingKeys(deps.app, deps.env, deps.keyring).read(
          configured.baseUrl === undefined ? configured.provider : endpointKeyName(configured.baseUrl),
        )?.key,
    }
  }
  const provider = settings.models?.[purpose]?.provider ?? settings.models?.default?.provider
  if (provider === "off") return undefined
  const shared = sharedModel(deps)
  return shared ? { target: shared.target, key: () => shared.key, shared: shared.setting } : undefined
}
