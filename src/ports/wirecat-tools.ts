export interface WireCatTool {
  command: string
  /** Its `AppIdentity.appName` and `envPrefix`: where its folders are, which no other tool may send. */
  appName: string
  envPrefix: string
  /** The npm package `setup` installs it from. */
  package: string
  /** The program on PATH, when it is not `command`: every WireCat tool writes a `wcat` launcher. */
  program?: string
  shown?: string
  does: string
}

/** Every WireCat tool, as "Works with" names it; a tool's own entry is left out of its screen. @experimental */
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
    command: "wcat",
    appName: "wcat",
    envPrefix: "WCAT",
    package: "@wirecat/wirecat",
    program: "wcat-wirecat",
    shown: "wcat context <person>",
    does: "one person across messengers, mail, notes and meetings",
  },
  {
    command: "files",
    appName: "files-cli",
    envPrefix: "FILES",
    package: "@wirecat/files-cli",
    does: "notes folders, Obsidian vaults, PDF and Word files, searchable with your other WireCat data",
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
    command: "amo",
    appName: "amo-cli",
    envPrefix: "AMO",
    package: "@wirecat/amo-cli",
    does: "amoCRM and Kommo: deals, contacts and companies, searchable with your other WireCat data",
  },
  {
    command: "attio",
    appName: "attio-cli",
    envPrefix: "WCATTIO",
    package: "@wirecat/attio-cli",
    does: "Attio CRM: deals, people and companies, searchable with your other WireCat data",
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
    command: "ydisk",
    appName: "yandex-disk-cli",
    envPrefix: "YDISK",
    package: "@wirecat/yandex-disk-cli",
    does: "Yandex Disk folders as local text, searchable with your other WireCat data",
  },
  {
    command: "wordpress",
    appName: "wordpress-cli",
    envPrefix: "WCWP",
    package: "@wirecat/wordpress-cli",
    does: "WordPress posts and pages, searchable with your other WireCat data",
  },
  {
    command: "linear",
    appName: "linear-cli",
    envPrefix: "WCLINEAR",
    package: "@wirecat/linear-cli",
    does: "Linear issues and projects, searchable with your other WireCat data",
  },
]
