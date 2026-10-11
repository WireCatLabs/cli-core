import type { MeetingProviderScope } from "./provider.js"

export type RecordingScope = MeetingProviderScope

export interface RecordingAsset {
  id: string | null
  type: string
  format: string | null
  size: number | null
  status: string
  available: boolean
  startedAt: string | null
  endedAt: string | null
}

export interface RecordingOccurrence {
  id: string
  externalId: string
  title: string | null
  startedAt: string | null
  assets: RecordingAsset[]
}

export interface RecordingWindow {
  from: string
  to: string
}

export interface RecordingPage {
  items: RecordingOccurrence[]
  nextCursor: string | null
}

export interface RecordingCatalog {
  readonly provider: string
  list(options: RecordingWindow & { account: string; cursor?: string; signal?: AbortSignal }): Promise<RecordingPage>
}

export interface RecordingAssetLocator extends RecordingScope {
  occurrenceId: string
  assetId: string
}

export interface ArchivedRecording {
  id: string
  path: string
  size: number
  sha256: string
  remoteSize: number | null
  type: string
  format: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface RecordingArchiveResult {
  externalId: string
  manifestPath: string
  downloaded: ArchivedRecording[]
  skipped: ArchivedRecording[]
  unavailable: RecordingAsset[]
}
