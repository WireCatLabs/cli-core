export interface ImageRef {
  kind: string
  name: string | null
  mime: string | null
  /** Where the messenger's file was saved, when it was. Level 1 never reads it. */
  localPath: string | null
}

export interface ContextMessage {
  sender: string | null
  text: string
  /** Epoch milliseconds. */
  sentAt: number
}

/** What the store knows around one image: its message and the chat's messages near it. */
export interface ImageContext {
  chatTitle: string | null
  sender: string | null
  caption: string
  sentAt: number
  /** The chat's messages before the image, nearest first. */
  before: ContextMessage[]
  /** The chat's messages after the image, nearest first. */
  after: ContextMessage[]
  signal?: AbortSignal
}

export interface ImageDescription {
  /** Searchable text; embedded like any other. */
  text?: string
  /** A vector of the provider's own space, for a provider that has one. */
  vector?: Float32Array
  metadata?: Record<string, unknown>
}

export interface ImageProvider {
  id: string
  /** Stored beside what the provider wrote: a new version describes every image again. */
  version: string
  describe(image: ImageRef, context: ImageContext): Promise<ImageDescription>
}
