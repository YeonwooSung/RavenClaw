import type { Tool } from '../types'

export function formatSettledOutput(
  tool: Tool,
  output: unknown,
): { content: string; persistPath?: string } {
  const persistPath = persistPathOf(output)
  let content: string
  if (typeof output === 'string') content = output
  else if (tool.renderResult) content = tool.renderResult(output)
  else if (output === undefined || output === null) content = ''
  else if (typeof output === 'object') {
    const body = (output as { content?: unknown }).content
    content = typeof body === 'string' ? body : JSON.stringify(output)
  } else {
    content = String(output)
  }
  return persistPath !== undefined ? { content, persistPath } : { content }
}

function persistPathOf(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined
  if (!('persistPath' in output)) return undefined
  const path = (output as { persistPath?: unknown }).persistPath
  return typeof path === 'string' && path.length > 0 ? path : undefined
}
