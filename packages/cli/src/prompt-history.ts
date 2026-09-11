import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '@ravenclaw/core'

const FILE_NAME = 'prompt-history.jsonl'
const MAX_LINES = 500

export function promptHistoryPath(home?: string): string {
  return join(home ?? ravenclawHome(), FILE_NAME)
}

export function appendPrompt(text: string, home?: string): void {
  if (text.trim() === '') return
  const dir = home ?? ravenclawHome()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, FILE_NAME)
  const lines = readRawLines(path)
  lines.push(JSON.stringify({ t: Date.now(), text }))
  const kept = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines
  writeFileSync(path, `${kept.join('\n')}\n`, 'utf8')
}

export function loadPrompts(home?: string): string[] {
  const out: string[] = []
  for (const line of readRawLines(promptHistoryPath(home))) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) continue
      if (!('text' in parsed)) continue
      const value = (parsed as { text: unknown }).text
      if (typeof value === 'string') out.push(value)
    } catch {
      // skip corrupt JSONL rows
    }
  }
  return out
}

function readRawLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
}
