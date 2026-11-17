export interface WireCatTool {
  command: string
  /** Its `AppIdentity.appName` and `envPrefix`: where its folders are, which no other tool may send. */
  appName: string
  envPrefix: string
  /** The npm package `setup` installs it from. */
  package: string
  shown?: string
  does: string
}

/** Every WireCat tool, as "Works with" names it; a tool's own entry is left out of its screen. */
export const WIRECAT_TOOLS: readonly WireCatTool[] = [
  {
    command: "tg",
    appName: "tg-cli",
    envPrefix: "TG",
    package: "@wirecat/tg-cli",
    does: "Telegram in the same local store: search, review and tasks offline",
  },
  {
    command: "max",
    appName: "max-cli",
    envPrefix: "MAX",
    package: "@wirecat/max-cli",
    does: "MAX in the same local store: search, review and tasks offline",
  },
  {
    command: "wa",
    appName: "whatsapp-cli",
    envPrefix: "WA",
    package: "@wirecat/whatsapp-cli",
    does: "WhatsApp in the same local store: search, review and tasks offline",
  },
  {
    command: "zm",
    appName: "zoom-cli",
    envPrefix: "ZM",
    package: "@wirecat/zoom-cli",
    does: "Zoom meetings: transcripts and summaries, searchable with your other WireCat data",
  },
  {
    command: "drive",
    appName: "drive-cli",
    envPrefix: "DRIVE",
    package: "@wirecat/drive-cli",
    does: "Google Drive and Docs as local text, searchable with your other WireCat data",
  },
  {
    command: "gcal",
    appName: "gcal-cli",
    envPrefix: "GCAL",
    package: "@wirecat/gcal-cli",
    does: "Google Calendar events, searchable with your other WireCat data",
  },
  {
    command: "memo",
    appName: "cli-memo",
    envPrefix: "MEMO",
    package: "@wirecat/cli-memo",
    shown: "memo context <person>",
    does: "one person across messengers, mail, notes and meetings",
  },
  {
    command: "mail",
    appName: "mail-cli",
    envPrefix: "MAIL",
    package: "@wirecat/mail-cli",
    does: "IMAP mail in the same local store: search your mailbox offline, next to your other WireCat data",
  },
  {
    command: "b24",
    appName: "bitrix24-cli",
    envPrefix: "B24",
    package: "@wirecat/bitrix24-cli",
    does: "Bitrix24 CRM: deals, leads and pipelines, searchable with your other WireCat data",
  },
  {
    command: "pbx",
    appName: "asterisk-cli",
    envPrefix: "PBX",
    package: "@wirecat/asterisk-cli",
    does: "Asterisk PBX calls and recordings, searchable with your other WireCat data",
  },
  {
    command: "notion",
    appName: "notion-cli",
    envPrefix: "WCNOTION",
    package: "@wirecat/notion-cli",
    does: "Notion pages and databases as local text, searchable with your other WireCat data",
  },
  {
    command: "hubspot",
    appName: "hubspot-cli",
    envPrefix: "WCHUBSPOT",
    package: "@wirecat/hubspot-cli",
    does: "HubSpot CRM: deals, contacts, companies and pipelines, searchable with your other WireCat data",
  },
]
