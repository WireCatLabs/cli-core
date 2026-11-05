import { createDecipheriv } from "node:crypto"

// Not protection: anyone holding the package can reveal these. It keeps secret scanners and a casual read from
// treating WireCat's public Desktop app as a leaked credential, as rclone does for its own app.
const KEY = Buffer.from("d43012779aa2dded3e98092a3dbcf5d8980c564172f5ce0a5fd0574e5f740339", "hex")

export const reveal = (obscured: string): string => {
  const bytes = Buffer.from(obscured, "base64url")
  const decipher = createDecipheriv("aes-256-ctr", KEY, bytes.subarray(0, 16))
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8")
}
