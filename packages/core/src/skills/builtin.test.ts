import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtinSkillsRoot, parseSkillFrontmatter } from '../tools/skill'

const REQUIRED = [
  'review',
  'test',
  'commit',
  'debug',
  'tdd',
  'plan',
  'frontend-design',
  'mcp-builder',
  'gamedev',
  'game-design',
  'team-design',
]

// Pinned at authoring time from the normative skill. The test must not read that file.
const TEAM_DESIGN_SKILL_B64 = 'LS0tCm5hbWU6IHRlYW0tZGVzaWduCmRlc2NyaXB0aW9uOiBEZXNpZ24gcHJvamVjdCBhZ2VudHMgYW5kIHNraWxscyB1bmRlciAucmF2ZW5jbGF3Ly4KLS0tCgojIHRlYW0tZGVzaWduCgpMb2FkIHRoaXMgYmVmb3JlIGRlc2lnbmluZyBhIHJldXNhYmxlIGFnZW50IHRlYW0gZm9yIHRoZSBjdXJyZW50IHByb2plY3QuIFRoZSBza2lsbCBpbmRleCBjYW5ub3QgY2FycnkgZXZlcnkgdHJpZ2dlciwgc28gdGhlIGJvZHkgZG9lcy4gVXNlIGl0IGZvciDtlZjrhKTsiqQg6rWs7ISxLCDsl5DsnbTsoITtirgg7YyALCAiZGVzaWduIGEgdGVhbSIsIHByb2plY3QgYWdlbnRzLCBhbmQgcHJvamVjdCBza2lsbHMuCgpEbyBub3QgYXBwbHkgcmV0cm9zcGVjdGl2ZSBmZWVkYmFjayBoZXJlLiBBZGRpbmcsIHJlbW92aW5nLCBvciByZXBsYWNpbmcgYSByb2xlIGlzIGluIHNjb3BlLiBUdW5pbmcgcHJvc2UgZnJvbSBhIHBhc3QgcnVuIGlzIG5vdC4KCkFzayB0aGUgdXNlciB0byBhY2NlcHQgdGhlIHJvc3RlciBiZWZvcmUgd3JpdGluZyBmaWxlcy4KCiMjIExvb2sgZmlyc3QKClJlYWQgLnJhdmVuY2xhdy9hZ2VudHMvIGFuZCAucmF2ZW5jbGF3L3NraWxscy8gb24gdGhlIHByb2plY3Qgcm9vdCwgcGx1cyB+Ly5yYXZlbmNsYXcvYWdlbnRzLyBhbmQgfi8ucmF2ZW5jbGF3L3NraWxscy8uIFRoZSBwcm9qZWN0IHJvb3QgaXMgcHJvamVjdEN3ZCB3aGVuIHRoZSB0dXJuIGhhcyBvbmUsIGFuZCBjd2Qgb3RoZXJ3aXNlLiBDb21wYXJlIHRoZW0gd2l0aCB0aGUgY2F0YWxvZyBpZHMgZ2VuZXJhbCwgZmlsZS1maW5kZXIsIGNvbW1hbmQtcnVubmVyLCByZXZpZXdlciwgYW5kIHJlc2VhcmNoZXItd2ViLgoKZ2VuZXJhbCBlZGl0cyBhbmQgaW5oZXJpdHMgdGhlIHBhcmVudCBwcm9tcHQsIHdpdGggUmVhZCwgR3JlcCwgR2xvYiwgTGlzdERpciwgRWRpdCwgV3JpdGUsIEFwcGx5UGF0Y2gsIEJhc2gsIGFuZCBTa2lsbCwgZm9yIGF0IG1vc3QgMzAgcm91bmRzLiBmaWxlLWZpbmRlciByZXR1cm5zIGF0IG1vc3QgMjAgbGluZXMsIHdpdGggUmVhZCwgR3JlcCwgYW5kIEdsb2IsIGZvciBhdCBtb3N0IDggcm91bmRzLiBjb21tYW5kLXJ1bm5lciBoYXMgUmVhZCBhbmQgQmFzaCwgcnVucyBhdCBtb3N0IDIgcm91bmRzLCBhbmQgZG9lcyBub3QgZXhwbG9yZSB0aGUgcmVwbyBvciBjaGFpbiBleHRyYSBjb21tYW5kcy4gcmV2aWV3ZXIgaGFzIG5vIHRvb2xzLCBzZWVzIHRoZSBwYXJlbnQgbWVzc2FnZXMsIGFuZCBydW5zIGF0IG1vc3QgNCByb3VuZHMuIHJlc2VhcmNoZXItd2ViIGhhcyBXZWJTZWFyY2ggYW5kIEZldGNoLCBmb3IgYXQgbW9zdCAxMiByb3VuZHMuCgpEbyBub3QgcmV1c2UgYSBjYXRhbG9nIGFnZW50IGlkIGZvciBhIG5ldyBkaXNrIGFnZW50LiBBIGZpbGUgd2l0aCBvbmUgb2YgdGhvc2UgaWRzIGlzIGlnbm9yZWQgd2hlbiBhIGNoaWxkIHJ1bnMuIFRoZSBjYXRhbG9nIGRlZmluaXRpb24gcnVucyBpbnN0ZWFkLgoKRG8gbm90IHNoYWRvdyBhIGJ1aWx0aW4gc2tpbGwgbmFtZS4gQSBwcm9qZWN0IHNraWxsIHdpdGggdGhlIHNhbWUgbmFtZSByZXBsYWNlcyB0aGUgYnVpbHRpbiBmb3IgdGhpcyBwcm9qZWN0LiBUaGUgbGl2ZSBza2lsbCBpbmRleCBpcyB0aGUgbGlzdCBvZiBuYW1lcyB5b3UgbXVzdCBub3QgcmV1c2UuCgpJZiBhIGNhdGFsb2cgaWQgYWxyZWFkeSBjb3ZlcnMgdGhlIHJvbGUsIG5hbWUgdGhhdCBpZCBpbiB0aGUgb3JjaGVzdHJhdG9yIGFuZCBkbyBub3Qgd3JpdGUgYSBkaXNrIGZpbGUuIElmIGEgcHJvamVjdCBza2lsbCBhbHJlYWR5IGNvdmVycyB0aGUgcHJvY2VkdXJlLCBleHRlbmQgdGhhdCBza2lsbC4KCkRvIG5vdCB3cml0ZSBhbiBhZ2VudCBuYW1lZCByb290LiBBIGRpc2sgZmlsZSBuYW1lZCByb290IGJlY29tZXMgYSBzcGF3bmFibGUgY2hpbGQgYW5kIHJ1bnMgdGhhdCBmaWxlLiBJdCBkb2VzIG5vdCBiZWNvbWUgdGhlIHNlc3Npb24gcm9vdC4KCiMjIFdoYXQgYSByb3N0ZXIgY29udGFpbnMKClByb3Bvc2UsIGFuZCBzdG9wOgoKLSBlYWNoIGRpc2sgYWdlbnQgaWQsIG9uZSBsaW5lIG9uIHRoZSByb2xlCi0gZWFjaCBwcm9qZWN0IHNraWxsIG5hbWUsIG9uZSBsaW5lIG9uIHRoZSBwcm9jZWR1cmUKLSBvbmUgb3JjaGVzdHJhdG9yIHNraWxsCi0gd2hldGhlciBhbiBhbHdheXMtb24gaG9vayB3aWxsIGJlIHdyaXR0ZW4KCldyaXRlIHByb2plY3QgYWdlbnRzIHVuZGVyIHRoZSBwcm9qZWN0IHJvb3QgLnJhdmVuY2xhdy9hZ2VudHMvIGFuZCBwcm9qZWN0IHNraWxscyB1bmRlciB0aGUgcHJvamVjdCByb290IC5yYXZlbmNsYXcvc2tpbGxzLy4gQSBzZXNzaW9uIHdvcmt0cmVlIGN3ZCBpcyB0aGUgd3JvbmcgZGlyZWN0b3J5LiBVc2Ugfi8ucmF2ZW5jbGF3L2FnZW50cy8gYW5kIH4vLnJhdmVuY2xhdy9za2lsbHMvIG9ubHkgd2hlbiB0aGUgdXNlciBhc2tzIGZvciBldmVyeSBwcm9qZWN0LgoKV3JpdGUgZ2VuZXJhdGVkIGZpbGVzIGluIHRoZSBsYW5ndWFnZSB0aGUgdXNlciBpcyB1c2luZy4gS2VlcCB0aGUgbGFuZ3VhZ2Ugb2YgYSBmaWxlIHlvdSBhcmUgZXh0ZW5kaW5nLgoKIyMgQWdlbnQgZmlsZQoKQW4gYWdlbnQgZmlsZSBzYXlzIHdobyB3b3Jrcy4gQSBza2lsbCBmaWxlIHNheXMgaG93LgoKYGBgbWFya2Rvd24KLS0tCm5hbWU6IGFuYWx5c3QKYWxsb3dlZC10b29sczogUmVhZCwgR3JlcCwgR2xvYgotLS0KClJvbGUsIGlucHV0cywgb3V0cHV0cywgYW5kIHdoYXQgdG8gZG8gb24gYSBiYWQgaW5wdXQuCmBgYAoKYG5hbWVgIG1hdGNoZXMgdGhlIGZpbGUgbmFtZSB3aXRob3V0IGAubWRgLiBEZWZhdWx0IGRpc2sgYWdlbnQgdG9vbHMgYXJlIFJlYWQsIEdyZXAsIGFuZCBHbG9iLiBPbWl0IGBhbGxvd2VkLXRvb2xzYCB0byBrZWVwIHRoYXQgZGVmYXVsdC4gQSBkaXNrIGFnZW50IHRoYXQgZWRpdHMgbGlzdHMgRWRpdCwgV3JpdGUsIGFuZCBBcHBseVBhdGNoIGluIGFsbG93ZWQtdG9vbHMuIEEgZGlzayBhZ2VudCB0aGF0IG11c3QgcnVuIGEgY29tbWFuZCBsaXN0cyBCYXNoIGluIGFsbG93ZWQtdG9vbHMuIFJlYWQtb25seSByZXZpZXcgdXNlcyB0aGUgY2F0YWxvZyByZXZpZXdlci4KClRoZSByb290IG9wZW5zIHRoZSBwcm9jZWR1cmUgc2tpbGwgYW5kIGNvcGllcyB0aGUgc3RlcHMgdGhlIGNoaWxkIG5lZWRzIGludG8gdGhlIEFnZW50IHByb21wdC4gVGhlIGRpc2sgYWdlbnQgYm9keSBzdGF5cyB0aGUgcm9sZS4gQSBkaXNrIGFnZW50IGRvZXMgbm90IHNlZSB0aGUgc2tpbGwgaW5kZXguCgpEaXNrIGFnZW50cyBydW4gYXQgbW9zdCAxMiByb3VuZHMuIERvIG5vdCBwcm9taXNlIGFub3RoZXIgbGltaXQuIERvIG5vdCBwdXQgYSBtb2RlbCBrZXkgaW4gYW4gYWdlbnQgZmlsZS4gVGhlIGxvYWRlciBpZ25vcmVzIGl0LiBBIGRpc2sgYWdlbnQgY2Fubm90IHNwYXduIGEgY2hpbGQuCgojIyBTa2lsbCBmaWxlCgpgYGBtYXJrZG93bgotLS0KbmFtZTogZG9tYWluLXJ1bgpkZXNjcmlwdGlvbjogUnVuIHRoZSBkb21haW4gdGVhbSBmb3IgdGhpcyBwcm9qZWN0LgotLS0KYGBgCgpUaGUgZGVzY3JpcHRpb24gaXMgb25lIGxpbmUgb2YgYXQgbW9zdCA2MCBjaGFyYWN0ZXJzLiBUaGUgdHJpZ2dlciB3b3JkcyBzaXQgaW5zaWRlIHRob3NlIDYwIGNoYXJhY3RlcnMuIERvIG5vdCBmb2xkIHRoZSBkZXNjcmlwdGlvbi4gRG8gbm90IHNldCBhbGxvd2VkLXRvb2xzIG9uIGEgZ2VuZXJhdGVkIHNraWxsLiBLZWVwIGVhY2ggZ2VuZXJhdGVkIFNLSUxMLm1kIHVuZGVyIDUwMCBsaW5lcy4gTW92ZSBkZXRhaWwgbmV4dCB0byBpdCB1bmRlciByZWZlcmVuY2VzLy4gT3BlbiBhIGdlbmVyYXRlZCByZWZlcmVuY2Ugd2l0aCB0aGUgU2tpbGwgdG9vbCBuYW1lIG9mIHRoYXQgZ2VuZXJhdGVkIHNraWxsIGFuZCB0aGUgcGF0aCBvZiB0aGUgcmVmZXJlbmNlLiBBIHBhdGggb3BlbmVkIGZyb20gdGVhbS1kZXNpZ24gc3RheXMgaW5zaWRlIHRoZSB0ZWFtLWRlc2lnbiBkaXJlY3RvcnkuCgpUaGUgb3JjaGVzdHJhdG9yIHNraWxsIGluY2x1ZGVzIG9uZSBzdWNjZXNzIGNoZWNrIGFuZCBvbmUgZmFpbHVyZSBjaGVjay4KCiMjIEhvdyB0aGUgdGVhbSBydW5zCgpUaGUgcm9vdCBzdGlsbCBkb2VzIHRoZSB3b3JrLiBBIGNoaWxkIGRvZXMgbm90IHNwYXduIGFub3RoZXIgY2hpbGQuIEF0IG1vc3QgNiBjaGlsZHJlbiBydW4gdG9nZXRoZXIuCgpEbyBub3Qgc2V0IGFnZW50c1tdIGFuZCBydW5faW5fYmFja2dyb3VuZCB0b2dldGhlci4gVGhhdCBjYWxsIHJldHVybnMgQWdlbnQgZmFpbGVkOiBhZ2VudHNbXSBjYW5ub3QgcnVuIGluIHRoZSBiYWNrZ3JvdW5kLgoKQ2FsbCBBZ2VudCB3aXRoIHN1YmFnZW50IHNldCB0byBhIGNhdGFsb2cgaWQgb3IgYSBkaXNrIGFnZW50IGlkLiBDYWxsIGEgZGlzayBpZCBvbmx5IGFmdGVyIHRoZSB1c2VyIGhhcyBhY2NlcHRlZCB0aGF0IGlkIGluIHRoZSByb3N0ZXIuIERvIG5vdCBhZGQgYSBwcmVzZXQgdG8gL2NyZXcuCgpXaGVuIHRoZSBncmFwaCBtYXRjaGVzIGEgcHJlc2V0LCBtYXRjaCB0aGUgd2F2ZSBzaGFwZSBhbmQgZG8gbm90IGludmVudCBhIHNsYXNoLiBSZXZpZXcgaXMgb25lIGZpbGUtZmluZGVyLCB0aGVuIG9uZSByZXZpZXdlci4gUmVzZWFyY2ggaXMgcmVzZWFyY2hlci13ZWIsIHBsdXMgZmlsZS1maW5kZXIgaW4gdGhlIHNhbWUgYWdlbnRzW10gYmF0Y2ggd2hlbiB0aGUgZ29hbCByZWZlcnMgdG8gdGhpcyByZXBvc2l0b3J5LiBJbXBsZW1lbnQgaXMgYWdlbnRzW10gb2YgZ2VuZXJhbCwgMSB0aHJvdWdoIDYsIGVhY2ggcHJvbXB0IGxpc3RpbmcgZXhjbHVzaXZlIHBhdGhzLCB0aGVuIG9uZSByZXZpZXdlci4KCklmIHRoZSB0b29sIHJlc3VsdCBjb250YWlucyBBZ2VudCBmYWlsZWQ6LCBTdWJhZ2VudCAnLCBVbmtub3duIHN1YmFnZW50OiwgYWJvcnRlZDosIG9yIHBlcm1pc3Npb25fZGVuaWVkOiwgcmVwb3J0IHRoYXQgcmVzdWx0IGFuZCBzdG9wLiBEbyBub3QgcmV0cnkuIERvIG5vdCBpbnZlbnQgdGhlIG1pc3NpbmcganVkZ21lbnQuCgpEbyBub3QgY3JlYXRlIC5yYXZlbmNsYXcvd29ya3NwYWNlLyB1bmxlc3MgdGhlIHVzZXIgYXNrcyBmb3IgaW50ZXJtZWRpYXRlIGZpbGVzLiBBZGQgLnJhdmVuY2xhdy93b3Jrc3BhY2UvIHRvIHRoZSBwcm9qZWN0J3MgLmdpdGlnbm9yZSB3aGVuIHlvdSBjcmVhdGUgaXQuCgojIyBBbHdheXMtb24gaG9vawoKVGhlIGFsd2F5cy1vbiBob29rIGlzIC5yYXZlbmNsYXcvUkFWRU4ubWQgYW5kIG9ubHkgYWZ0ZXIgYSBzZXBhcmF0ZSB5ZXMuIEFwcGVuZCBleGFjdGx5IHRoaXMgc2VjdGlvbiwgb3IgcmVwbGFjZSBhbiBleGlzdGluZyBzZWN0aW9uIHdpdGggdGhlIHNhbWUgaGVhZGluZy4gRG8gbm90IHdyaXRlIGFueSBvdGhlciBpbnN0cnVjdGlvbiBmaWxlLgoKYGBgbWFya2Rvd24KIyMgVGVhbToge25hbWV9CgoqKkdvYWw6Kioge29uZSBsaW5lfQoKKipXaGVuOioqIEZvciB7ZG9tYWlufSB3b3JrLCBvcGVuIHRoZSBza2lsbCBge3NraWxsLW5hbWV9YC4gQSBkaXJlY3QgcXVlc3Rpb24gY2FuIGJlIGFuc3dlcmVkIHdpdGhvdXQgaXQuCmBgYAoKUHV0IHRoZSBjaGFuZ2UgbG9nIGluIHRoZSBvcmNoZXN0cmF0b3Igc2tpbGwgdW5kZXIgIyMgQ2hhbmdlcy4gRWFjaCBlbnRyeSBpcyBvbmUgbGluZSB3aXRoIHRoZSBkYXRlLCB0aGUgdGFyZ2V0LCBhbmQgdGhlIHJlYXNvbi4gRG8gbm90IHB1dCB0aGUgcm9zdGVyIG9yIHRoZSBjaGFuZ2UgbG9nIGluIHRoZSBob29rLgo='

describe('builtin skills', () => {
  test('each bundled skill has name, description, and a body', () => {
    const root = builtinSkillsRoot()
    const names = readdirSync(root).filter((name) => !name.startsWith('.'))
    expect(names.sort()).toEqual([...REQUIRED].sort())
    for (const name of names) {
      const markdown = readFileSync(join(root, name, 'SKILL.md'), 'utf8')
      const fm = parseSkillFrontmatter(markdown)
      expect(fm.name).toBe(name)
      expect((fm.description ?? '').length).toBeGreaterThan(8)
      expect(markdown).not.toContain('Claude')
      expect(markdown).not.toContain('Anthropic')
    }
  })

  test('mcp-builder verifies spawn via raven mcp tools, not in-session /mcp after reload', () => {
    const markdown = readFileSync(join(builtinSkillsRoot(), 'mcp-builder', 'SKILL.md'), 'utf8')
    expect(markdown).toContain('raven mcp tools')
    expect(markdown).not.toMatch(/Verify with `\/mcp`/)
  })

  test('gamedev is one router over a 74-skill catalog', () => {
    const root = builtinSkillsRoot()
    const top = readdirSync(root).filter((name) => !name.startsWith('.'))
    expect(top).not.toContain('router')
    const catalog = join(root, 'gamedev', 'catalog')
    const dirs = readdirSync(catalog, { withFileTypes: true }).filter((ent) => ent.isDirectory())
    expect(dirs).toHaveLength(74)
    const names = dirs.map((ent) => ent.name)
    expect(names).not.toContain('router')
    for (const name of names) {
      const markdown = readFileSync(join(catalog, name, 'SKILL.md'), 'utf8')
      const fm = parseSkillFrontmatter(markdown)
      expect(fm.name).toBe(name)
      const description = fm.description ?? ''
      expect(description.length).toBeGreaterThan(8)
      expect(description).not.toBe('>')
      expect(description).not.toBe('|')
    }
    for (const name of [
      'phaser-core',
      'godot-gdscript',
      'unity-csharp-scripting',
      'unreal-blueprints',
      'threejs-scene-setup',
      'platformer',
      'save-systems',
      'itch-publish',
    ]) {
      expect(names).toContain(name)
    }

    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name)
        if (ent.isDirectory()) {
          walk(path)
          continue
        }
        const text = readFileSync(path).toString('utf8').toLowerCase()
        expect(text).not.toContain('claude')
        expect(text).not.toContain('anthropic')
      }
    }
    walk(join(root, 'gamedev'))

    const router = readFileSync(join(root, 'gamedev', 'SKILL.md'), 'utf8')
    expect(router).toContain('catalog/phaser-core/SKILL.md')
    expect(router).toContain('Skill tool')
    expect(router).toContain(
      'description: Game-dev router: Godot, Unity, Unreal, web, and genres.',
    )
    expect(router).toContain(
      'After a web page exists, run `raven play` and do not claim the scene works until the browser has been looked at.',
    )
  })

  test('game-design is a one-page original skill with no tool narrow', () => {
    const markdown = readFileSync(join(builtinSkillsRoot(), 'game-design', 'SKILL.md'), 'utf8')
    const fm = parseSkillFrontmatter(markdown)
    expect(fm.name).toBe('game-design')
    expect(fm.description).toBe('One-page game design before code: loop, pillars, scope.')
    expect(fm.allowedTools).toBeUndefined()
    expect(markdown).not.toContain('allowed-tools')
    expect(markdown).toContain('fantasy')
    expect(markdown).toContain('player verb')
    expect(markdown).toContain('core loop')
    expect(markdown).toContain('pillars')
    expect(markdown).toContain('scope box')
    expect(markdown).toContain('session length')
    expect(markdown).toContain('riskiest assumption')
    expect(markdown).toContain('playtest question')
    expect(markdown).toContain('Do not implement until the user accepts')
    expect(markdown).toContain('name `gamedev`')
    expect(markdown).toContain('catalog/level-design/SKILL.md')
    expect(markdown).toContain('catalog/game-feel/SKILL.md')
    expect(markdown).toContain('catalog/game-jam/SKILL.md')
    expect(markdown).toContain('catalog/prototype-fast/SKILL.md')
  })

  test('team-design pins the normative skill and the roster rules', () => {
    const markdown = readFileSync(join(builtinSkillsRoot(), 'team-design', 'SKILL.md'), 'utf8')
    const fm = parseSkillFrontmatter(markdown)
    expect(fm.name).toBe('team-design')
    expect(fm.description).toBe('Design project agents and skills under .ravenclaw/.')
    expect(fm.allowedTools).toBeUndefined()
    expect((fm.description ?? '').length).toBeLessThanOrEqual(60)
    const expected = Buffer.from(TEAM_DESIGN_SKILL_B64, 'base64').toString('utf8')
    expect(markdown).toBe(expected)
    for (const sentence of [
      'Ask the user to accept the roster before writing files.',
      'Do not reuse a catalog agent id for a new disk agent.',
      'Do not shadow a builtin skill name.',
      'The live skill index is the list of names you must not reuse.',
      'Do not write an agent named root.',
      'A disk file named root becomes a spawnable child and runs that file. It does not become the session root.',
      'The project root is projectCwd when the turn has one, and cwd otherwise.',
      'general edits and inherits the parent prompt, with Read, Grep, Glob, ListDir, Edit, Write, ApplyPatch, Bash, and Skill, for at most 30 rounds.',
      'file-finder returns at most 20 lines, with Read, Grep, and Glob, for at most 8 rounds.',
      'command-runner has Read and Bash, runs at most 2 rounds, and does not explore the repo or chain extra commands.',
      'reviewer has no tools, sees the parent messages, and runs at most 4 rounds.',
      'researcher-web has WebSearch and Fetch, for at most 12 rounds.',
      'Write project agents under the project root .ravenclaw/agents/ and project skills under the project root .ravenclaw/skills/.',
      'A session worktree cwd is the wrong directory.',
      'Write generated files in the language the user is using.',
      'Keep the language of a file you are extending.',
      'Default disk agent tools are Read, Grep, and Glob.',
      'A disk agent that edits lists Edit, Write, and ApplyPatch in allowed-tools.',
      'Read-only review uses the catalog reviewer.',
      'The root opens the procedure skill and copies the steps the child needs into the Agent prompt.',
      'The disk agent body stays the role.',
      'A disk agent does not see the skill index.',
      'Open a generated reference with the Skill tool name of that generated skill and the path of the reference.',
      'A path opened from team-design stays inside the team-design directory.',
      'Disk agents run at most 12 rounds.',
      'Do not put a model key in an agent file.',
      'The orchestrator skill includes one success check and one failure check.',
      'Call a disk id only after the user has accepted that id in the roster.',
      'When the graph matches a preset, match the wave shape and do not invent a slash.',
      'Review is one file-finder, then one reviewer.',
      'Research is researcher-web, plus file-finder in the same agents[] batch when the goal refers to this repository.',
      'Implement is agents[] of general, 1 through 6, each prompt listing exclusive paths, then one reviewer.',
      'If the tool result contains Agent failed:, Subagent \', Unknown subagent:, aborted:, or permission_denied:, report that result and stop. Do not retry. Do not invent the missing judgment.',
      'The root still does the work.',
      'A child does not spawn another child.',
      'At most 6 children run together.',
      'Do not set agents[] and run_in_background together.',
      'That call returns Agent failed: agents[] cannot run in the background.',
      'Do not add a preset to /crew.',
      'Do not create .ravenclaw/workspace/ unless the user asks for intermediate files.',
      'The always-on hook is .ravenclaw/RAVEN.md and only after a separate yes.',
      'Do not write any other instruction file.',
      'Each entry is one line with the date, the target, and the reason.',
      'Do not apply retrospective feedback here.',
    ]) {
      expect(markdown).toContain(sentence)
    }
    const banned = [
      'SendMessage',
      'TeamCreate',
      'TeamDelete',
      '.claude/',
      'fable',
      'opus',
      'sonnet',
      'Workflow',
    ]
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name)
        if (ent.isDirectory()) {
          walk(path)
          continue
        }
        const text = readFileSync(path).toString('utf8')
        const lower = text.toLowerCase()
        expect(lower).not.toContain('claude')
        expect(lower).not.toContain('anthropic')
        for (const word of banned) expect(text).not.toContain(word)
      }
    }
    walk(join(builtinSkillsRoot(), 'team-design'))
  })
})
