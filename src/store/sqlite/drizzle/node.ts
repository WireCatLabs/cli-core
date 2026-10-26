// biome-ignore-all lint/plugin/no-sqlite-driver: cli-core owns the store, so it opens the driver itself
export { drizzle } from "drizzle-orm/node-sqlite"
