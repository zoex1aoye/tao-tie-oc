import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type ContextTier = "small" | "standard" | "large"

export interface Thresholds {
  warn: number
  critical: number
  autoPrune: boolean
}

export interface SubagentConfig {
  thresholds: Thresholds
  turnProtection: number
}

export interface ModelOverride {
  thresholds?: Partial<Thresholds>
  turnProtection?: number
}

export interface PluginConfig {
  thresholds: Thresholds
  turnProtection: number
  subagent: SubagentConfig
  models: Record<string, ModelOverride>
  compactionHintFrequency: number
  debug: boolean
}

function contextTier(contextLimit: number): ContextTier {
  if (contextLimit <= 200_000) return "small"
  if (contextLimit < 1_000_000) return "standard"
  return "large"
}

function defaultThresholds(tier: ContextTier): { warn: number; critical: number; turnProtection: number } {
  switch (tier) {
    case "small":
      return { warn: 0.60, critical: 0.80, turnProtection: 4 }
    case "standard":
      return { warn: 0.75, critical: 0.90, turnProtection: 8 }
    case "large":
      return { warn: 0.80, critical: 0.95, turnProtection: 10 }
  }
}

const SUBAGENT_DEFAULTS = {
  thresholds: { warn: 0.60, critical: 0.80, autoPrune: true },
  turnProtection: 4,
}

const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "opencode", "tune-context.json")
const PROJECT_CONFIG_PATH = ".opencode/tune-context.json"

interface RawConfig {
  thresholds?: {
    warn?: number | null
    critical?: number | null
    autoPrune?: boolean
  }
  turnProtection?: number | null
  subagent?: {
    thresholds?: { warn?: number; critical?: number }
    turnProtection?: number
  }
  models?: Record<string, ModelOverride>
  compactionHintFrequency?: number
  debug?: boolean
}

export function loadConfig(projectDir: string | null): RawConfig {
  const paths: string[] = [GLOBAL_CONFIG_PATH]
  if (projectDir) {
    paths.push(join(projectDir, PROJECT_CONFIG_PATH))
  }

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8")
        return JSON.parse(raw) as RawConfig
      } catch {
        // ignore malformed config files
      }
    }
  }

  return {}
}

export function resolveConfig(raw: RawConfig, contextLimit: number): PluginConfig {
  const tier = contextTier(contextLimit)
  const defaults = defaultThresholds(tier)

  const warn = raw.thresholds?.warn ?? defaults.warn
  const critical = raw.thresholds?.critical ?? defaults.critical
  const autoPrune = raw.thresholds?.autoPrune ?? true

  const baseConfig: PluginConfig = {
    thresholds: { warn, critical, autoPrune },
    turnProtection: raw.turnProtection ?? defaults.turnProtection,
    subagent: {
      thresholds: {
        warn: raw.subagent?.thresholds?.warn ?? SUBAGENT_DEFAULTS.thresholds.warn,
        critical: raw.subagent?.thresholds?.critical ?? SUBAGENT_DEFAULTS.thresholds.critical,
        autoPrune: true,
      },
      turnProtection: raw.subagent?.turnProtection ?? SUBAGENT_DEFAULTS.turnProtection,
    },
    models: raw.models ?? {},
    compactionHintFrequency: raw.compactionHintFrequency ?? 3,
    debug: raw.debug ?? false,
  }

  return baseConfig
}

export function resolveThresholds(config: PluginConfig, contextLimit: number, isSubagent: boolean): {
  warnAbsolute: number
  criticalAbsolute: number
  turnProtection: number
} {
  const { thresholds, turnProtection, subagent } = config

  if (isSubagent) {
    return {
      warnAbsolute: Math.floor(contextLimit * subagent.thresholds.warn),
      criticalAbsolute: Math.floor(contextLimit * subagent.thresholds.critical),
      turnProtection: subagent.turnProtection,
    }
  }

  return {
    warnAbsolute: Math.floor(contextLimit * thresholds.warn),
    criticalAbsolute: Math.floor(contextLimit * thresholds.critical),
    turnProtection,
  }
}
