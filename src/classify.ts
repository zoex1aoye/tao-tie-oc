import type { Part, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk"
import { buildTrimNotice } from "./system.js"

export type PartValue = "keep" | "trim" | "drop"

export interface ClassifyContext {
  messageRole: "user" | "assistant"
  turnIndex: number
  readAttachedFileIds?: Set<string>
}

function isCompletedTool(part: ToolPart): part is ToolPart & { state: ToolStateCompleted } {
  return part.state.status === "completed"
}

const TRIM_TOOLS = new Set(["read", "bash", "webfetch"])
const DROP_TOOLS = new Set(["list", "apply_patch"])

export function classifyPart(part: Part, ctx: ClassifyContext): PartValue {
  switch (part.type) {
    case "reasoning":
    case "snapshot":
      return "drop"

    case "compaction":
    case "patch":
    case "agent":
    case "step-start":
    case "step-finish":
    case "retry":
    case "subtask":
      return "keep"

    case "file": {
      if (part.id && ctx.readAttachedFileIds?.has(part.id)) {
        return "drop"
      }
      return "keep"
    }

    case "text":
      return "keep"

    case "tool": {
      if (!isCompletedTool(part)) return "keep"
      if (TRIM_TOOLS.has(part.tool)) return "trim"
      if (DROP_TOOLS.has(part.tool)) return "drop"
      return "keep"
    }

    default:
      return "keep"
  }
}

export function shouldPrune(
  tokenUsage: number,
  contextLimit: number,
  warnAbsolute: number,
  criticalAbsolute: number,
  lastPruneTokenUsage: number | null,
): { shouldPrune: boolean; critical: boolean } {
  if (tokenUsage >= contextLimit) return { shouldPrune: true, critical: true }
  if (tokenUsage < warnAbsolute) return { shouldPrune: false, critical: false }

  if (lastPruneTokenUsage !== null) {
    const growth = (tokenUsage - lastPruneTokenUsage) / lastPruneTokenUsage
    if (growth < 0.05) return { shouldPrune: false, critical: false }
  }

  return {
    shouldPrune: true,
    critical: tokenUsage >= criticalAbsolute,
  }
}

function summarizeReadOutput(output: string, title: string | undefined): string {
  const lines = output.split("\n")
  const lineCount = lines.length
  const pathMatch = title?.match(/^Read\s+(.+)/)
  const path = pathMatch?.[1] ?? "unknown"
  const preview = lines.slice(0, 3).join("\n")

  return [
    buildTrimNotice("read"),
    `File: ${path} (${lineCount} lines)`,
    "--- preview (first 3 lines) ---",
    preview,
  ].join("\n")
}

function trimToLastLines(output: string, maxLines: number): string {
  const lines = output.split("\n")
  if (lines.length <= maxLines) return output

  const tail = lines.slice(-maxLines)
  return [
    buildTrimNotice("bash"),
    `[${lines.length - maxLines} lines omitted]`,
    ...tail,
  ].join("\n")
}

function summarizeWebfetchOutput(output: string, title: string | undefined): string {
  const lines = output.split("\n")
  const urlMatch = title?.match(/^Fetch\s+(.+)/) ?? title?.match(/^Webfetch\s+(.+)/)
  const url = urlMatch?.[1] ?? "unknown"
  const preview = lines.slice(0, 5).join("\n")

  return [
    buildTrimNotice("webfetch"),
    `URL: ${url} (${lines.length} lines)`,
    "--- preview (first 5 lines) ---",
    preview,
  ].join("\n")
}

export function trimPart(part: ToolPart): Part {
  if (!isCompletedTool(part)) return part

  switch (part.tool) {
    case "read":
      return { ...part, state: { ...part.state, output: summarizeReadOutput(part.state.output, part.state.title) } }
    case "bash":
      return { ...part, state: { ...part.state, output: trimToLastLines(part.state.output, 20) } }
    case "webfetch":
      return { ...part, state: { ...part.state, output: summarizeWebfetchOutput(part.state.output, part.state.title) } }
    default:
      return part
  }
}
