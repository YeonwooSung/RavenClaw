import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { reply, replyError, serveStdio } from './mcp-stdio'

const PROTOCOL_VERSION = '2025-03-26'

const TOOLS = [
  {
    name: 'fs_list',
    description: 'List a directory under MCP_ROOT',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'fs_read',
    description: 'Read a UTF-8 file under MCP_ROOT',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
]

function rootDir(): string {
  const raw = process.env.MCP_ROOT
  if (!raw) throw new Error('MCP_ROOT is required')
  return resolve(raw)
}

function confined(rel: string): string {
  const root = rootDir()
  const abs = resolve(root, rel)
  const relToRoot = relative(root, abs)
  if (relToRoot.startsWith('..') || relToRoot.startsWith(`..${sep}`)) {
    throw new Error('path escapes MCP_ROOT')
  }
  return abs
}

function stringArg(params: unknown, key: string): string {
  if (!params || typeof params !== 'object') return ''
  const args =
    'arguments' in params ? (params as { arguments?: unknown }).arguments : undefined
  if (!args || typeof args !== 'object') return ''
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function handleMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return
  const rec = message as { id?: unknown; method?: unknown; params?: unknown }
  if (typeof rec.method !== 'string') return
  if (typeof rec.id !== 'number' && typeof rec.id !== 'string') return

  if (rec.method === 'initialize') {
    reply(rec.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'fs', version: '0.0.0' },
    })
    return
  }

  if (rec.method === 'tools/list') {
    reply(rec.id, { tools: TOOLS })
    return
  }

  if (rec.method !== 'tools/call') {
    replyError(rec.id, 'Method not found')
    return
  }

  const name =
    rec.params && typeof rec.params === 'object' && 'name' in rec.params
      ? (rec.params as { name?: unknown }).name
      : undefined

  try {
    if (name === 'fs_list') {
      const abs = confined(stringArg(rec.params, 'path') || '.')
      const names = readdirSync(abs)
      reply(rec.id, { content: [{ type: 'text', text: names.join('\n') }] })
      return
    }
    if (name === 'fs_read') {
      const abs = confined(stringArg(rec.params, 'path'))
      if (!statSync(abs).isFile()) throw new Error('not a file')
      const text = readFileSync(abs, 'utf8')
      if (text.includes('\0')) throw new Error('binary file')
      reply(rec.id, { content: [{ type: 'text', text }] })
      return
    }
    replyError(rec.id, 'Unknown tool')
  } catch (error) {
    replyError(rec.id, error instanceof Error ? error.message : String(error), -32000)
  }
}

if (import.meta.main) {
  void serveStdio(handleMessage)
}