import type { SessionState } from "./session.js"
import { resolveThresholds, type PluginConfig } from "./config.js"

const PRUNE_MARKER = "[trimmed by tune-context-plugin]"

function largeContextPrompt(warnPercent: number): string {
  return (
    "This session uses automatic context pruning to keep your " +
    "attention focused. Older tool outputs, reasoning traces, " +
    `and fetched web content are trimmed when context exceeds ${warnPercent}%. ` +
    "Your instructions, decisions, and file changes are preserved."
  )
}

function smallContextPrompt(warnPercent: number): string {
  return (
    "Context space is limited. Automatic pruning removes old tool " +
    `outputs and reasoning traces when usage exceeds ${warnPercent}% to ` +
    "prevent hitting the context limit. " +
    "Key information from previous steps is preserved. " +
    "Re-read files if you need full content again."
  )
}

function buildFooter(): string {
  return `Trimmed content is marked with ${PRUNE_MARKER}.`
}

function buildSystemPrompt(contextLimit: number, warnPercent: number, autoPrune: boolean): string[] {
  if (!autoPrune) return [buildFooter()]
  if (contextLimit >= 1_000_000) return [largeContextPrompt(warnPercent), buildFooter()]
  return [smallContextPrompt(warnPercent), buildFooter()]
}

function buildCompactionHint(
  usagePercent: number,
  usedTokens: number,
  contextLimit: number,
  warnPercent: number,
  warnAbsolute: number,
): string {
  return (
    `Context: ${usagePercent}% (${usedTokens}/${contextLimit}). ` +
    `Next auto-prune will trigger at ${warnPercent}% (${warnAbsolute} tokens).`
  )
}

export function buildTrimNotice(tool: string): string {
  return `[trimmed by tune-context-plugin: ${tool} output truncated]`
}

export function createSystemTransformHandler(
  stateMap: Map<string, SessionState>,
  config: PluginConfig,
): (input: { model: { limit: { context: number }; id: string } }, output: { system: string[] }) => Promise<void> {
  return async (
    input: { model: { limit: { context: number }; id: string } },
    output: { system: string[] },
  ) => {
    const contextLimit = input.model.limit.context
    if (contextLimit <= 0) return

    const modelId = input.model.id

    let sessionId: string | null = null
    for (const [id, state] of stateMap) {
      if (state.modelId === modelId || state.modelId === null) {
        sessionId = id
        break
      }
    }
    if (!sessionId) return

    const state = stateMap.get(sessionId)
    if (!state) return

    state.modelId = modelId
    state.contextLimit = contextLimit

    const isSubagent = state.parentSessionId !== null
    resolveThresholds(config, contextLimit, isSubagent)
    const warnPercent = config.thresholds.warn
    const autoPrune = config.thresholds.autoPrune

    const prompts = buildSystemPrompt(contextLimit, Math.round(warnPercent * 100), autoPrune)
    output.system.push(...prompts)
  }
}

export function createCompactingHookHandler(
  stateMap: Map<string, SessionState>,
  config: PluginConfig,
): (input: { sessionID: string }, output: { context: string[] }) => Promise<void> {
  return async (input: { sessionID: string }, output: { context: string[] }) => {
    const state = stateMap.get(input.sessionID)
    if (!state) return

    const contextLimit = state.contextLimit ?? 1_000_000
    const isSubagent = state.parentSessionId !== null
    const { warnAbsolute } = resolveThresholds(config, contextLimit, isSubagent)
    const warnPercent = config.thresholds.warn

    const lastHint = state.lastCompactionHintAt
    const frequency = config.compactionHintFrequency

    if (lastHint !== null && frequency > 0) {
      const timeSinceLastHint = Date.now() - lastHint
      const minIntervalMs = frequency * 60_000
      if (timeSinceLastHint < minIntervalMs) return
    }

    const usedTokens = state.lastTokenUsage ?? 0
    const usagePercent = contextLimit > 0 ? Math.round((usedTokens / contextLimit) * 100) : 0

    const hint = buildCompactionHint(
      usagePercent,
      usedTokens,
      contextLimit,
      Math.round(warnPercent * 100),
      warnAbsolute,
    )

    output.context.push(hint)
    state.lastCompactionHintAt = Date.now()
  }
}
