import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const DEFAULT_AGENTS = [
  'general',
  'file-finder',
  'command-runner',
  'reviewer',
  'researcher-web',
] as const

const MAX_FILE_CHARS = 20_000
const MAX_FILES = 3
const MENTION_RE = /(^|[\s])@([^\s]+)/g
const EXT_RE = /\.[A-Za-z0-9]+$/

export function expandMentions(
  text: string,
  cwd: string,
  agents?: string[],
): { text: string; files: string[]; agents: string[] } {
  const catalog = new Set(agents ?? DEFAULT_AGENTS)
  const attached: { rel: string; contents: string }[] = []
  const mentionedAgents: string[] = []
  const seenFiles = new Set<string>()
  const seenAgents = new Set<string>()

  for (const token of collectMentionTokens(text)) {
    if (catalog.has(token)) {
      if (!seenAgents.has(token)) {
        seenAgents.add(token)
        mentionedAgents.push(token)
      }
      continue
    }
    if (!isPathish(token) || attached.length >= MAX_FILES) continue
    const file = readMentionFile(cwd, token)
    if (!file || seenFiles.has(file.rel)) continue
    seenFiles.add(file.rel)
    attached.push(file)
  }

  let next = text
  for (const file of attached) {
    next += `\n\n<file path="${file.rel}">\n${file.contents}\n</file>`
  }
  return { text: next, files: attached.map((file) => file.rel), agents: mentionedAgents }
}

function collectMentionTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[2]
    if (token) tokens.push(token)
  }
  return tokens
}

function isPathish(token: string): boolean {
  return token.includes('/') || EXT_RE.test(token)
}

function readMentionFile(cwd: string, token: string): { rel: string; contents: string } | undefined {
  const abs = resolve(cwd, token)
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) return undefined
  if (!existsSync(abs)) return undefined
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
    if (!statSync(real).isFile()) return undefined
    const contents = readFileSync(real, 'utf8').slice(0, MAX_FILE_CHARS)
    const rel = relative(cwd, abs)
    return { rel: rel === '' ? token : rel, contents }
  } catch {
    return undefined
  }
}
