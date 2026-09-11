const ALWAYS = new Set(['EnterPlanMode', 'ExitPlanMode'])

export function parseAllowedTools(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function filterToolsByAllowList<T extends { name: string }>(
  tools: T[],
  allow?: string[],
): T[] {
  if (allow === undefined || allow.length === 0) return tools
  const names = new Set(allow)
  return tools.filter((tool) => names.has(tool.name) || ALWAYS.has(tool.name))
}
