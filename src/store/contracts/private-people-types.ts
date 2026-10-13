export interface PrivateContactNote {
  id: string
  personId: string
  text: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PrivateContact {
  personId: string
  alias: string | null
  notes: PrivateContactNote[]
}
