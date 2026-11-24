import type { ErrorReason } from "@wirecat/cli-base/standards"

export type Entry = [reason: string, code: ErrorReason["code"], message: string]

export const validation = (reason: string, message: string): Entry => [reason, "validation_error", message]

/** The read-only SFTP client (`./sftp`). */
export const SFTP: Entry[] = [
  ["sftp.host-key-missing", "configuration_error", "no host key is pinned for the SFTP server"],
  ["sftp.host-key-mismatch", "authentication_error", "the SFTP server's host key is not the pinned one"],
  ["sftp.auth-missing", "configuration_error", "an SFTP connection needs a password or a private key"],
  ["sftp.key-invalid", "configuration_error", "the SFTP private key or its passphrase cannot be read"],
  ["sftp.library-missing", "configuration_error", "SFTP needs the ssh2 package in the CLI's dependencies"],
  ["sftp.timeout", "timeout", "the SFTP server did not answer in time"],
  validation("sftp.too-large", "the file is larger than the read's byte limit"),
  validation("sftp.closed", "the SFTP connection was closed before the operation"),
  validation("sftp.file-changed", "the file changed on the server while a stream read it; read it again"),
  ["ssh.forward-refused", "permission_error", "the SSH server does not allow forwarding to that address"],
  ["ssh.forward-failed", "network_error", "the SSH server could not reach the address behind it"],
]
