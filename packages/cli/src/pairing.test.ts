import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PAIRING_TTL_MS,
  approvePairingCode,
  formatPairingList,
  handlePairingCli,
  isPairingApproved,
  issueOrReusePending,
  revokePairing,
} from './pairing'

function tempHome(): string {
  const dir = join(tmpdir(), `raven-pairing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('pairing', () => {
  test('issues, reuses, expires, approves, revokes, and fail-closes', async () => {
    const home = tempHome()
    let now = 1_000_000
    const clock = () => now
    const first = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '123456',
    })
    expect(first).toEqual({ code: '123456', reused: false })
    const again = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '999999',
    })
    expect(again).toEqual({ code: '123456', reused: true })
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    now = 1_000_000 + PAIRING_TTL_MS + 1
    expect(approvePairingCode(home, '123456', { now: clock })).toEqual({
      ok: false,
      error: 'unknown or expired code',
    })
    const fresh = issueOrReusePending(home, 'discord', 'U1', {
      now: clock,
      randomCode: () => '654321',
    })
    expect(fresh.reused).toBe(false)
    expect(approvePairingCode(home, '654321', { now: clock })).toEqual({
      ok: true,
      platform: 'discord',
      userId: 'U1',
    })
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(true)
    expect(revokePairing(home, 'discord', 'U1')).toBe(true)
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    writeFileSync(join(home, 'pairing.json'), '{not-json', 'utf8')
    expect(isPairingApproved(home, 'discord', 'U1')).toBe(false)

    const listed = formatPairingList(home, { now: clock })
    expect(listed).not.toMatch(/sk-|token|xoxb/i)
  })

  test('handlePairingCli approve unknown exits 1', async () => {
    const home = tempHome()
    const code = await handlePairingCli(['approve', '000000'], { home, now: () => 1 })
    expect(code).toBe(1)
  })
})
