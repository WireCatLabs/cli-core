import type { ContextMessage, ImageContext, ImageProvider } from "../types.js"

/** Messages taken on each side of the image. */
export const CONTEXT_MESSAGES = 3
/** How far, in minutes, a message may be from the image and still describe it. */
export const CONTEXT_MINUTES = 10

const MAX_CHARS = 1_200

const line = ({ sender, text }: ContextMessage) => (sender ? `${sender}: ${text.trim()}` : text.trim())

const near = (messages: ContextMessage[], sentAt: number) =>
  messages
    .filter(({ text, sentAt: at }) => text.trim() && Math.abs(at - sentAt) <= CONTEXT_MINUTES * 60_000)
    .slice(0, CONTEXT_MESSAGES)

/**
 * What the chat says around a photo, as the photo's own text. The chat title and the sender alone say nothing
 * about the picture, so without a caption or a neighbour there is no text.
 */
export const contextText = ({
  chatTitle,
  sender,
  caption,
  sentAt,
  before,
  after,
}: ImageContext): string | undefined => {
  const earlier = near(before, sentAt).reverse()
  const later = near(after, sentAt)
  if (!caption.trim() && earlier.length === 0 && later.length === 0) return undefined
  const own = line({ sender, text: `[photo] ${caption}`, sentAt })
  const lines = [...(chatTitle?.trim() ? [chatTitle.trim()] : []), ...earlier.map(line), own, ...later.map(line)]
  return lines.join("\n").slice(0, MAX_CHARS)
}

export const context: ImageProvider = {
  id: "context",
  version: "1",
  describe: async (_image, imageContext) => {
    const text = contextText(imageContext)
    return text === undefined ? {} : { text }
  },
}
