import type { StreamEvent } from '@ravenclaw/core'

export interface TuiView {
  apply(event: StreamEvent): void
  lines(): string[]
  reset(): void
  append(text: string): void
}

type Row =
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'labeled'; text: string }

export function createOpenTuiView(): TuiView {
  let rows: Row[] = []

  return {
    apply(event) {
      rows = applyEvent(rows, event)
    },
    lines() {
      return rows.map(paint)
    },
    reset() {
      rows = []
    },
    append(text) {
      rows = label(rows, text)
    },
  }
}

export function composerLine(draft = '', busy = false): string {
  return `${busy ? '… ' : '> '}${draft}`
}

export function permissionPromptLines(
  event: Extract<StreamEvent, { type: 'permission_ask' }>,
): string[] {
  const title = event.childSessionId
    ? `Allow ${event.tool}? (child ${event.childSessionId})`
    : `Allow ${event.tool}?`
  return [title, event.message, 'y allow   n deny   a always   i skip']
}

function applyEvent(rows: Row[], event: StreamEvent): Row[] {
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
      return label(rows, `tool_call  ${event.name}`)
    case 'tool_progress':
      return label(rows, `tool_progress  ${event.text}`)
    case 'tool_result':
      return label(rows, `tool_result  ${event.result.ok ? 'ok' : 'error'}`)
    case 'status':
      return label(rows, `status  ${event.message}`)
    case 'error':
      return label(rows, `error  ${event.message}`)
    case 'compact':
      return label(rows, `compact  ${event.summary}`)
    case 'usage':
      return label(rows, `usage  ${event.usage.input}↑ ${event.usage.output}↓`)
    case 'permission_ask':
      return label(rows, `permission_ask  ${event.tool}`)
    case 'round_start':
      return label(rows, `round_start  ${event.round}`)
    case 'round_end':
      return label(rows, `round_end  ${event.end.reason}`)
  }
}

function label(rows: Row[], text: string): Row[] {
  return [...rows, { kind: 'labeled', text }]
}

function paint(row: Row): string {
  if (row.kind === 'thinking') return `thinking  ${row.text}`
  return row.text
}
