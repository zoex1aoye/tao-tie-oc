import { writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import type { Event, Session } from "@opencode-ai/sdk"

export interface SessionStats {
  pruneCallCount: number
  totalPrunedTokens: number
}

export interface SessionState {
  sessionId: string | null
  parentSessionId: string | null
  modelId: string | null
  contextLimit: number | null
  lastTokenUsage: number | null
  lastPruneTokenUsage: number | null
  totalPrunedTokens: number
  lastCompactionHintAt: number | null
  stats: SessionStats
}

function createSessionState(sessionId: string | null, parentSessionId: string | null): SessionState {
  return {
    sessionId,
    parentSessionId,
    modelId: null,
    contextLimit: null,
    lastTokenUsage: null,
    lastPruneTokenUsage: null,
    totalPrunedTokens: 0,
    lastCompactionHintAt: null,
    stats: {
      pruneCallCount: 0,
      totalPrunedTokens: 0,
    },
  }
}

const STORAGE_DIR = join(homedir(), ".local", "share", "opencode", "storage", "plugins", "tune-context")

function storagePath(sessionId: string): string {
  return join(STORAGE_DIR, `${sessionId}.json`)
}

export function saveState(state: SessionState): void {
  if (!state.sessionId) return
  const path = storagePath(state.sessionId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8")
}

function getSessionId(event: Event): string | null {
  switch (event.type) {
    case "session.created":
    case "session.updated":
      return (event.properties.info as Session).id
    case "session.compacted":
      return event.properties.sessionID
    default:
      return null
  }
}

function getParentId(event: Event): string | undefined {
  if (event.type === "session.created") {
    return (event.properties.info as Session).parentID
  }
  return undefined
}

export function createEventHandler(
  stateMap: Map<string, SessionState>,
  debug: boolean,
): (input: { event: Event }) => Promise<void> {
  return async (input: { event: Event }) => {
    const { event } = input
    const sessionId = getSessionId(event)
    if (!sessionId) return

    switch (event.type) {
      case "session.created": {
        const parentId = getParentId(event) ?? null
        if (stateMap.has(sessionId)) return

        const state = createSessionState(sessionId, parentId)
        stateMap.set(sessionId, state)
        saveState(state)

        if (debug) {
          // eslint-disable-next-line no-console
          console.log(`[tune-context] session.created: ${sessionId}${parentId ? ` (subagent of ${parentId})` : ""}`)
        }
        break
      }

      case "session.updated": {
        if (!stateMap.has(sessionId)) {
          const parentId = getParentId(event) ?? null
          stateMap.set(sessionId, createSessionState(sessionId, parentId))
        }
        break
      }

      case "session.compacted": {
        const state = stateMap.get(sessionId)
        if (!state) return
        state.lastCompactionHintAt = Date.now()
        saveState(state)
        break
      }
    }
  }
}
