export interface WriterLease {
  /** Releases this owner's marker; cleanup remains usable after cancellation. */
  release(): Promise<void>
}

export interface WriterLeaseInfo {
  name: string
  status: "active" | "stale" | "foreign" | "unrecognized"
  pid: number | null
  host: string | null
}

export interface WriterLeaseOptions {
  signal?: AbortSignal
}

export type WriterLeaseAcquisition =
  | { status: "acquired"; lease: WriterLease }
  | { status: "busy"; locks: WriterLeaseInfo[] }
  | { status: "legacy" }

export interface WriterLeaseStore {
  inspect(destination: string, options?: WriterLeaseOptions): Promise<WriterLeaseInfo[]>
  recover(
    destination: string,
    options?: WriterLeaseOptions & { apply?: boolean },
  ): Promise<{ locks: WriterLeaseInfo[]; removed: string[] }>
  acquire(destination: string, options?: WriterLeaseOptions): Promise<WriterLeaseAcquisition>
}
