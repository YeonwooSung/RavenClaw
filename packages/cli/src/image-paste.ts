import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { UserImage, UserSubmitInput } from '@ravenclaw/core'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export function mediaTypeForPath(path: string): string | undefined {
  return MEDIA[extname(path).toLowerCase()]
}

export function readImageFile(path: string): UserImage | undefined {
  const mediaType = mediaTypeForPath(path)
  if (!mediaType || !existsSync(path)) return undefined
  try {
    if (!statSync(path).isFile()) return undefined
    const data = readFileSync(path).toString('base64')
    if (data.length === 0) return undefined
    return { mediaType, data }
  } catch {
    return undefined
  }
}

function resolveImageInCwd(cwd: string, raw: string): string | undefined {
  const abs = resolve(cwd, raw)
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) return undefined
  if (!existsSync(abs)) return undefined
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(root)
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined
    return real
  } catch {
    return undefined
  }
}

const PATH_REF = /(?:^|\s)@([^\s]+\.(?:png|jpe?g|gif|webp))\b/gi

export function collectUserImages(
  text: string,
  cwd: string,
  clipboard?: () => UserImage | undefined,
): UserSubmitInput {
  const images: UserImage[] = []
  const seen = new Set<string>()

  const add = (image: UserImage | undefined) => {
    if (!image) return
    const key = `${image.mediaType}:${image.data.slice(0, 32)}`
    if (seen.has(key)) return
    seen.add(key)
    images.push(image)
  }

  const trimmed = text.trim()
  if (IMAGE_EXT.has(extname(trimmed).toLowerCase())) {
    const path = resolveImageInCwd(cwd, trimmed)
    if (path) add(readImageFile(path))
  }
  for (const match of text.matchAll(PATH_REF)) {
    const raw = match[1]
    if (!raw) continue
    const path = resolveImageInCwd(cwd, raw)
    if (path) add(readImageFile(path))
  }
  // Clipboard is opt-in for empty submits only. Attaching it on every
  // non-empty turn would send leftover screenshots with ordinary prompts.
  if (trimmed === '' && clipboard) add(clipboard())

  if (images.length === 0) return text
  return { text, images }
}

/** osascript prints «data PNGf<hex>», not raw hex. */
export function parseOsascriptPng(stdout: string): Buffer | undefined {
  const compact = stdout.replace(/\s+/g, '')
  const match = /PNG[fF]([0-9A-Fa-f]+)/.exec(compact)
  const hex = match?.[1]
  if (!hex || hex.length < 16 || hex.length % 2 !== 0) return undefined
  const buf = Buffer.from(hex, 'hex')
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return undefined
  return buf
}

export function readClipboardImage(): UserImage | undefined {
  if (process.platform !== 'darwin') return undefined
  const png = spawnSync(
    'osascript',
    ['-e', 'try\nset d to the clipboard as «class PNGf»\nreturn d\non error\nreturn ""\nend try'],
    { encoding: 'utf8', timeout: 2000 },
  )
  const buf = parseOsascriptPng(png.stdout ?? '')
  if (!buf) return undefined
  return { mediaType: 'image/png', data: buf.toString('base64') }
}
