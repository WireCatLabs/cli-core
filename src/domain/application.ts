/** Who a messenger CLI is: the word people type, where its files live, what its variables start with. */
export interface AppIdentity {
  /** `tg`, `max` — in usage lines and in every message that tells somebody what to type. */
  command: string
  /** `tg-cli` — the directory name under the OS conventions, and the keyring service. */
  appName: string
  /** `TG` gives `TG_PROFILE`, `TG_TIMEOUT`, `TG_CONFIG_DIR`… */
  envPrefix: string
  description: string
  version: string
  /** Where a problem report goes — a new-issue page. `doctor report create` names it. */
  issues?: string
  /** The language of the transcript a person reads: its day headings and the word for "you". `ru-RU` when unset. */
  locale?: string
  errorContract?: import("./failure-format.js").ErrorContract
}

export const envName = (app: AppIdentity, name: string): string => `${app.envPrefix}_${name}`
