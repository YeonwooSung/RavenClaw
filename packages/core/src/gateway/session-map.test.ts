import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewaySessionsPath, loadSessionMap, resolveSessionId, saveSessionMap } from './session-map'
import { sessionKey, type InboundEvent } from './types'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-gateway-'))
  tempDirs.push(dir)
  return dir
}

function event(over: Partial<InboundEvent> & Pick<InboundEvent, 'chatType'>): InboundEvent {
  return {
    platform: over.platform ?? 'slack',
    chatId: over.chatId ?? 'C1',
    chatType: over.chatType,
    userId: over.userId ?? 'U1',
    text: over.text ?? 'hi',
    ...(over.threadId !== undefined ? { threadId: over.threadId } : {}),
    ...(over.messageId !== undefined ? { messageId: over.messageId } : {}),
  }
}

describe('sessionKey', () => {
  test('dm is platform:dm:chatId with no user', () => {
    expect(sessionKey(event({ chatType: 'dm', platform: 'discord', chatId: 'D9', userId: 'U99' }))).toBe(
      'discord:dm:D9',
    )
  })

  test('group appends userId', () => {
    expect(sessionKey(event({ chatType: 'group', platform: 'slack', chatId: 'C2', userId: 'U7' }))).toBe(
      'slack:group:C2:U7',
    )
  })

  test('thread is chatId+threadId with no user', () => {
    expect(
      sessionKey(
        event({ chatType: 'thread', platform: 'slack', chatId: 'C3', threadId: 'T4', userId: 'U8' }),
      ),
    ).toBe('slack:thread:C3:T4')
  })
})

describe('session map', () => {
  test('missing file loads an empty map', () => {
    const home = tempHome()
    expect(loadSessionMap(home)).toEqual({})
    expect(existsSync(gatewaySessionsPath(home))).toBe(false)
  })

  test('saves under home/gateway/sessions.json and reloads', () => {
    const home = tempHome()
    const map = { 'slack:dm:D1': 'sess_a' }
    saveSessionMap(map, home)
    const path = join(home, 'gateway', 'sessions.json')
    expect(path).toBe(gatewaySessionsPath(home))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(map)
    expect(loadSessionMap(home)).toEqual(map)
  })

  test('resolveSessionId creates once then reuses', () => {
    const map: Record<string, string> = {}
    let n = 0
    const createId = () => {
      n += 1
      return `sess_${n}`
    }
    const first = resolveSessionId(map, 'slack:group:C1:U1', createId)
    expect(first).toEqual({ id: 'sess_1', created: true })
    const second = resolveSessionId(map, 'slack:group:C1:U1', createId)
    expect(second).toEqual({ id: 'sess_1', created: false })
    expect(n).toBe(1)
    expect(map['slack:group:C1:U1']).toBe('sess_1')
  })

  test('resolve then save persists the new id', () => {
    const home = tempHome()
    const map = loadSessionMap(home)
    const resolved = resolveSessionId(map, 'discord:dm:D2', () => 'sess_new')
    expect(resolved.created).toBe(true)
    saveSessionMap(map, home)
    expect(loadSessionMap(home)).toEqual({ 'discord:dm:D2': 'sess_new' })
  })

  test('invalid JSON object throws', () => {
    const home = tempHome()
    const path = gatewaySessionsPath(home)
    mkdirSync(join(home, 'gateway'), { recursive: true })
    writeFileSync(path, '[]\n', 'utf8')
    expect(() => loadSessionMap(home)).toThrow(/invalid gateway sessions file/)
  })
})
