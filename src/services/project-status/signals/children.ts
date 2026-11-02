import type { StatusItem, StatusSignal } from "../types.js"

export interface ChildrenData {
  child: string
  key: string | null
  name: string | null
  depth: number | null
  /** Linked chats read for it; a chat linked to two projects counts once, under the first. */
  chats: number | null
  /** Why it was not read: deeper than two levels, seen twice, or past eight children. */
  cut: "depth" | "cycle" | "limit" | null
}

/** Child projects (a confirmed `member-of` link to this one) that were read, and those cut. */
export const children: StatusSignal<ChildrenData> = {
  id: "children",
  version: 1,
  scope: "project",
  read: async (context) => {
    const item = (data: ChildrenData): StatusItem<ChildrenData> => ({
      signal: "children",
      chat: null,
      at: null,
      who: null,
      evidence: [{ ref: data.child, fingerprint: null }],
      basis: "store",
      data,
    })
    return [
      ...context.project.children.map((child) =>
        item({
          child: child.ref,
          key: child.key,
          name: child.name,
          depth: child.depth,
          chats: context.chats.filter((chat) => chat.project === child.ref).length,
          cut: null,
        }),
      ),
      ...context.project.cut.map(({ ref, reason }) =>
        item({ child: ref, key: null, name: null, depth: null, chats: null, cut: reason }),
      ),
    ]
  },
}
