import type { Message, AssistantMessage } from "@opencode-ai/sdk"

function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.role === "assistant"
}

export function getTokenUsage(messages: Message[]): number {
  return messages
    .filter(isAssistantMessage)
    .reduce((sum, m) => sum + m.tokens.input + m.tokens.output, 0)
}


