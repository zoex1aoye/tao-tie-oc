import type { Part, Message, AssistantMessage } from "@opencode-ai/sdk"
import type { SessionState } from "./session.js"
import { resolveThresholds, type PluginConfig } from "./config.js"
import { getTokenUsage } from "./tokens.js"
import { classifyPart, shouldPrune, trimPart } from "./classify.js"

interface MessageEntry {
  info: Message
  parts: Part[]
}

function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.role === "assistant"
}

function buildReadAttachedFileIds(messages: MessageEntry[]): Map<number, Set<string>> {
  const result = new Map<number, Set<string>>()

  for (let i = 0; i < messages.length; i++) {
    const { parts } = messages[i]
    for (const part of parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        const fileIds = new Set<string>()
        for (const attachment of part.state.attachments ?? []) {
          fileIds.add(attachment.id)
        }
        if (fileIds.size > 0) {
          result.set(i, fileIds)
        }
      }
    }
  }

  return result
}

function getSessionId(messages: MessageEntry[], stateMap: Map<string, SessionState>): string | null {
  for (const entry of messages) {
    if (entry.info.sessionID) return entry.info.sessionID
  }
  for (const [id] of stateMap) {
    return id
  }
  return null
}

export function createMessagesTransformHandler(
  stateMap: Map<string, SessionState>,
  config: PluginConfig,
  debug: boolean,
): (input: {}, output: { messages: MessageEntry[] }) => Promise<void> {
  return async (_input: {}, output: { messages: MessageEntry[] }) => {
    const { messages } = output
    if (messages.length === 0) return

    const sessionId = getSessionId(messages, stateMap)
    if (!sessionId) return

    const state = stateMap.get(sessionId)
    if (!state) return

    if (!config.thresholds.autoPrune) return

    const contextLimit = state.contextLimit ?? 1_000_000
    const tokenUsage = getTokenUsage(messages.map(m => m.info))
    const isSubagent = state.parentSessionId !== null

    const { warnAbsolute, criticalAbsolute, turnProtection } = resolveThresholds(config, contextLimit, isSubagent)

    const { shouldPrune: should, critical } = shouldPrune(
      tokenUsage,
      contextLimit,
      warnAbsolute,
      criticalAbsolute,
      state.lastPruneTokenUsage,
    )
    if (!should) return

    const effectiveTurnProtection = critical ? Math.max(2, Math.floor(turnProtection / 2)) : turnProtection
    const pruneStart = Math.max(0, messages.length - effectiveTurnProtection)

    const readFileIdMap = buildReadAttachedFileIds(messages)

    let prunedTokens = 0

    for (let i = 0; i < pruneStart; i++) {
      const entry = messages[i]
      const { info: messageInfo, parts } = entry
      const messageRole = messageInfo.role === "assistant" ? "assistant" : "user"

      const readFileIds = readFileIdMap.get(i)

      const newParts: Part[] = []

      for (const part of parts) {
        const value = classifyPart(part, {
          messageRole,
          turnIndex: i,
          readAttachedFileIds: readFileIds,
        })

        switch (value) {
          case "keep":
            newParts.push(part)
            break
          case "trim":
            if (part.type === "tool") {
              const beforeLen = part.state.status === "completed" ? part.state.output.length : 0
              newParts.push(trimPart(part))
              prunedTokens += beforeLen - 0
            } else {
              newParts.push(part)
            }
            break
          case "drop":
            if (isAssistantMessage(messageInfo)) {
              const tokens = messageInfo.tokens
              prunedTokens += tokens.input + tokens.output
            }
            break
        }
      }

      entry.parts = newParts
    }

    state.lastTokenUsage = tokenUsage
    state.lastPruneTokenUsage = tokenUsage
    state.totalPrunedTokens += prunedTokens
    state.stats.pruneCallCount += 1
    state.stats.totalPrunedTokens += prunedTokens

    if (debug) {
      // eslint-disable-next-line no-console
      console.log(`[tune-context] pruned ${prunedTokens} chars across ${pruneStart} messages (critical=${critical})`)
    }
  }
}
