import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { SessionState } from "./session.js"
import { loadConfig, resolveConfig } from "./config.js"
import { createEventHandler } from "./session.js"
import { createMessagesTransformHandler } from "./auto-prune.js"
import { createSystemTransformHandler, createCompactingHookHandler } from "./system.js"

const stateMap = new Map<string, SessionState>()

export default async function plugin(input: PluginInput, _options?: PluginOptions): Promise<Hooks> {
  const { directory } = input
  const rawConfig = loadConfig(directory)
  const config = resolveConfig(rawConfig, 1_000_000)
  const debug = config.debug

  if (debug) {
    // eslint-disable-next-line no-console
    console.log("[tune-context] plugin initialized")
  }

  return {
    event: createEventHandler(stateMap, debug),

    "experimental.chat.messages.transform": createMessagesTransformHandler(stateMap, config, debug),

    "experimental.chat.system.transform": createSystemTransformHandler(stateMap, config),

    "experimental.session.compacting": createCompactingHookHandler(stateMap, config),
  }
}
