import type { TextRange } from "../../conversations/chunks.js"

/** A chunk of the chat's current build: its hash, and the messages its text is cut from. */
export interface ChunkToEmbed {
  hash: string
  lines: { id: string; sender: string | null; text: string }[]
}

export interface NearestChunk {
  conversationPk: number
  firstMessagePk: number
  lastMessagePk: number
  /** The stretch of one long message, when the chunk is a piece of it. */
  range?: TextRange
  hash: string
  score: number
}
