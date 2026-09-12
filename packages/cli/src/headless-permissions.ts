export type HeadlessToolsPreset = 'read' | 'write' | 'ci'

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'ListDir', 'ReadSubtree', 'Skill'] as const
const WRITE_EXTRA = ['Edit', 'Write', 'ApplyPatch', 'NotebookEdit'] as const

export function parseHeadlessToolsPreset(value: string): HeadlessToolsPreset {
  if (value === 'read' || value === 'write' || value === 'ci') return value
  throw new Error(`unknown tools preset: ${value} (expected read, write, or ci)`)
}

/** ci puts Bash in the pool. dontAsk still denies leftover Bash unless a project allow rule matches. */
export function headlessAllowedTools(preset: HeadlessToolsPreset): string[] {
  if (preset === 'read') return [...READ_TOOLS]
  if (preset === 'write') return [...READ_TOOLS, ...WRITE_EXTRA]
  return [...READ_TOOLS, ...WRITE_EXTRA, 'Bash']
}
