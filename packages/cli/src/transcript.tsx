import { Box, Text } from 'ink'
import type { Message, StreamEvent, ToolResult } from '@ravenclaw/core'

export type TranscriptRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: ToolResult }
  | { kind: 'status'; message: string }
  | { kind: 'compact'; summary: string }
  | { kind: 'error'; message: string }

export type TranscriptProps = {
  rows: TranscriptRow[]
  selectedIndex?: number
  expandedIds?: ReadonlySet<string>
  onToggleExpand?: (id: string) => void
}

const COMPACT_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export const RESULT_CLIP = 2000
export const TRANSCRIPT_WINDOW = 200
export const TRANSCRIPT_EXPAND_KEY = 'ctrl+o'

export function windowedRows(
  rows: readonly TranscriptRow[],
  selectedIndex?: number,
  window = TRANSCRIPT_WINDOW,
): { rows: TranscriptRow[]; offset: number } {
  if (rows.length <= window) return { rows: [...rows], offset: 0 }
  let start = rows.length - window
  if (selectedIndex !== undefined && selectedIndex < start) {
    start = Math.max(0, selectedIndex)
  }
  return { rows: rows.slice(start), offset: start }
}

export function isCompactTool(name: string): boolean {
  return COMPACT_TOOLS.has(name)
}

export function clipToolResult(text: string): string {
  return clip(text, RESULT_CLIP)
}

export function toggleExpanded(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectedToolId(
  rows: readonly TranscriptRow[],
  selectedIndex: number | undefined,
): string | undefined {
  if (selectedIndex === undefined || selectedIndex < 0) return undefined
  const row = rows[selectedIndex]
  return row?.kind === 'tool' ? row.id : undefined
}

export function shouldToggleExpand(
  input: string,
  key: { ctrl?: boolean },
): boolean {
  return key.ctrl === true && (input === 'o' || input === 'O')
}

export function visibleToolResult(
  row: Extract<TranscriptRow, { kind: 'tool' }>,
  expandedIds?: ReadonlySet<string>,
): string | undefined {
  const content = row.result?.content
  if (!content) return undefined
  if (isCompactTool(row.name) && expandedIds?.has(row.id) !== true) return undefined
  return clipToolResult(content)
}

export function formatToolRow(name: string, input: unknown): string {
  const label = toolArg(name, input)
  return label ? `${name} ${label}` : name
}

function toolArg(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    return typeof rec.path === 'string' ? rec.path : undefined
  }
  if (name === 'Grep' || name === 'Glob') {
    return typeof rec.pattern === 'string' ? rec.pattern : undefined
  }
  if (name === 'Bash') {
    return typeof rec.command === 'string' ? clip(rec.command, 60) : undefined
  }
  if (name === 'Skill') {
    return typeof rec.name === 'string' ? rec.name : undefined
  }
  return undefined
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function applyStreamEvent(rows: TranscriptRow[], event: StreamEvent): TranscriptRow[] {
  switch (event.type) {
    case 'text_delta': {
      const last = rows[rows.length - 1]
      if (last?.kind === 'assistant') {
        return [...rows.slice(0, -1), { kind: 'assistant', text: last.text + event.text }]
      }
      return [...rows, { kind: 'assistant', text: event.text }]
    }
    case 'thinking_delta': {
      const last = rows[rows.length - 1]
      if (last?.kind === 'thinking') {
        return [...rows.slice(0, -1), { kind: 'thinking', text: last.text + event.text }]
      }
      return [...rows, { kind: 'thinking', text: event.text }]
    }
    case 'tool_call':
      return [
        ...rows,
        { kind: 'tool', id: event.id, name: event.name, input: event.input },
      ]
    case 'tool_result':
      return rows.map((row) =>
        row.kind === 'tool' && row.id === event.id ? { ...row, result: event.result } : row,
      )
    case 'status':
      return [...rows, { kind: 'status', message: event.message }]
    case 'compact':
      return [...rows, { kind: 'compact', summary: event.summary }]
    case 'error':
      return [...rows, { kind: 'error', message: event.message }]
    default:
      return rows
  }
}

export function rowsFromMessages(messages: Message[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (text) rows.push({ kind: 'user', text })
      continue
    }
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'text' && block.text) {
          rows.push({ kind: 'assistant', text: block.text })
        } else if (block.type === 'thinking' && block.text) {
          rows.push({ kind: 'thinking', text: block.text })
        } else if (block.type === 'tool_use') {
          rows.push({
            kind: 'tool',
            id: block.id,
            name: block.name,
            input: block.input,
          })
        }
      }
      continue
    }
    const idx = rows.findIndex((row) => row.kind === 'tool' && row.id === msg.toolUseId)
    if (idx >= 0) {
      const row = rows[idx]
      if (row?.kind === 'tool') {
        const next: TranscriptRow = {
          ...row,
          result: {
            toolUseId: msg.toolUseId,
            ok: msg.ok,
            content:
              msg.blocks.find((block): block is { type: 'text'; text: string } => block.type === 'text')
                ?.text ?? '',
          },
        }
        rows[idx] = next
      }
    }
  }
  return rows
}

export function Transcript(props: TranscriptProps) {
  const windowed = windowedRows(props.rows, props.selectedIndex)
  return (
    <Box flexDirection="column">
      {windowed.rows.map((row, i) => (
        <TranscriptItem
          key={rowKey(row, windowed.offset + i)}
          row={row}
          selected={props.selectedIndex === windowed.offset + i}
          expandedIds={props.expandedIds}
        />
      ))}
    </Box>
  )
}

function rowKey(row: TranscriptRow, index: number): string {
  if (row.kind === 'tool') return `tool:${row.id}`
  return `${row.kind}:${index}`
}

function TranscriptItem(props: {
  row: TranscriptRow
  selected: boolean
  expandedIds?: ReadonlySet<string>
}) {
  const { row, selected } = props
  switch (row.kind) {
    case 'user':
      return <Text inverse={selected}>{`you  ${row.text}`}</Text>
    case 'assistant':
      return <Text inverse={selected}>{row.text}</Text>
    case 'thinking':
      return <Text dimColor inverse={selected}>{row.text}</Text>
    case 'tool': {
      const compact = isCompactTool(row.name)
      const mark = row.result ? (row.result.ok ? '✓' : '✗') : '•'
      const result = visibleToolResult(row, props.expandedIds)
      const header = (
        <Text dimColor={compact} inverse={selected}>
          {`${mark} ${formatToolRow(row.name, row.input)}`}
        </Text>
      )
      if (result === undefined) return header
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{result}</Text>
        </Box>
      )
    }
    case 'status':
      return <Text dimColor inverse={selected}>{row.message}</Text>
    case 'compact':
      return <Text dimColor inverse={selected}>{`compact  ${clip(row.summary, 80)}`}</Text>
    case 'error':
      return <Text color="red" inverse={selected}>{row.message}</Text>
  }
}
