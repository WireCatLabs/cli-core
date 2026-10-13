import { context } from "./context/index.js"
import type { ImageProvider } from "./types.js"

/** The order is the contract: the first provider that gives an image text describes it. */
const BUILT_INS: readonly ImageProvider[] = [context]

let providers: ImageProvider[] = [...BUILT_INS]

export const registeredImageProviders = (): readonly ImageProvider[] => providers

/** Adds a provider, or replaces the one with the same id in place. `before` puts it ahead of another provider. */
export const registerImageProvider = (provider: ImageProvider, options: { before?: string } = {}): (() => void) => {
  const without = providers.filter((existing) => existing.id !== provider.id)
  let at = providers.findIndex((existing) => existing.id === provider.id)
  if (options.before !== undefined) {
    at = without.findIndex((existing) => existing.id === options.before)
    if (at === -1) throw new Error(`no image provider named ${options.before} to register ${provider.id} before`)
  } else if (at === -1) at = without.length
  providers = [...without.slice(0, at), provider, ...without.slice(at)]
  return () => {
    providers = providers.filter((existing) => existing !== provider)
  }
}
