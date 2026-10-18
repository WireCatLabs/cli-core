import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { listenRelay, RELAY_PROTOCOL, type RelayAddress, relayPath } from "../../background/relay.js"
import type { MessageEvent } from "../../domain/models.js"
import { readOnlyLockOf } from "../../ports/app.js"
import { type MessengerAdapter, throughWrapper } from "../../ports/messenger.js"
import { environmentOf } from "../context.js"
import type { Messenger } from "./context.js"

/**
 * Someone else's open connection, lent to one command: closing it does nothing, it never feeds the store a second
 * time, and its `watch` listens through the owner's `watchers` — without them, the lent connection has no `watch`.
 */
export const lentConnection = (
  connection: MessengerAdapter,
  watchers?: Set<(event: MessageEvent) => void>,
): MessengerAdapter =>
  throughWrapper(connection, {
    close: async () => {},
    feed: undefined,
    listen: undefined,
    ...(connection.watch && watchers
      ? {
          // A watcher that throws (its output limit, a closed reader) ends its own watch, never serve's.
          watch: async (onEvent: (event: MessageEvent) => void, signal: AbortSignal, onReady?: () => void) => {
            let watcher: ((event: MessageEvent) => void) | undefined
            try {
              await new Promise<void>((resolve, reject) => {
                watcher = (event) => {
                  try {
                    onEvent(event)
                  } catch (error) {
                    reject(error)
                  }
                }
                watchers.add(watcher)
                signal.addEventListener("abort", () => resolve(), { once: true })
                onReady?.()
                if (signal.aborted) resolve()
              })
            } finally {
              if (watcher) watchers.delete(watcher)
            }
          },
        }
      : { watch: undefined }),
  } as unknown as MessengerAdapter)

/**
 * serve's side of the relay (NEED-1389): it keeps the raw connection its messenger opened and lends it to the
 * commands clients send it. A borrowed connection never closes serve's, never feeds the store a second time, and
 * listens through serve's own events instead of a second `watch`.
 */
export const serveRelay = (command: Command, messenger: Messenger) => {
  let held: MessengerAdapter | undefined
  let relay: { close: () => Promise<void> } | undefined
  const watchers = new Set<(event: MessageEvent) => void>()

  const borrowed = (): MessengerAdapter => {
    const connection = held
    if (!connection) throw new CliError("provider_unavailable", "serve is not connected yet", { retryable: true })
    return lentConnection(connection, watchers)
  }

  return {
    messenger: {
      ...messenger,
      connect: async (...args: Parameters<Messenger["connect"]>) => {
        held = await messenger.connect(...args)
        return held
      },
    } satisfies Messenger,
    arrived: (event: MessageEvent) => {
      for (const watcher of watchers) watcher(event)
    },
    /** Listens beside the lock; the address goes into it, which is how a client finds it. */
    open: async (lockPath: string, profile: string): Promise<RelayAddress | undefined> => {
      const environment = environmentOf(command)
      const runCommand = environment.runCommand
      if (!runCommand) return undefined
      const readOnly = readOnlyLockOf(messenger.app, environment.env ?? process.env)
      const path = relayPath(lockPath)
      relay = await listenRelay(path, (request, io) =>
        runCommand(request.argv, {
          env: {
            ...request.env,
            ...(readOnly ? { [`${messenger.app.envPrefix}_READ_ONLY`]: "1" } : {}),
          },
          streams: io.streams,
          stdin: io.stdin,
          stdout: io.stdout,
          tty: request.tty,
          signal: io.signal,
          answer: () => null,
          relayed: { profile, cwd: request.cwd, connection: borrowed },
        }),
      )
      return { path, protocol: RELAY_PROTOCOL }
    },
    close: async () => {
      await relay?.close()
    },
  }
}
