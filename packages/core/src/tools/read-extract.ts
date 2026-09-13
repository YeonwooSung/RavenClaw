import { inflateRawSync } from 'node:zlib'

export type OfficeExt = '.docx' | '.xlsx'

const MAX_INFLATE = 2_000_000

export function extractOfficeText(
  buf: Buffer,
  ext: OfficeExt,
): { ok: true; text: string } | { ok: false } {
  try {
    const files = unzipEntries(buf, (name) => wantedOfficePath(name, ext))
    if (ext === '.docx') {
      const xml = files.get('word/document.xml')
      if (xml === undefined) return { ok: false }
      return { ok: true, text: extractDocxText(xml.toString('utf8')) }
    }
    const strings = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '')
    const sheets = [...files.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort()
    if (sheets.length === 0) return { ok: false }
    const parts: string[] = []
    for (const name of sheets) {
      const xml = files.get(name)
      if (xml === undefined) continue
      const text = extractSheetText(xml.toString('utf8'), strings)
      if (text.length > 0) parts.push(text)
    }
    return { ok: true, text: parts.join('\n') }
  } catch {
    return { ok: false }
  }
}

function extractDocxText(xml: string): string {
  const lines: string[] = []
  for (const para of xml.split(/<\/w:p>/i)) {
    const texts = [...para.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((m) =>
      decodeXml(m[1] ?? ''),
    )
    const line = texts.join('')
    if (line.length > 0) lines.push(line)
  }
  return lines.join('\n')
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
  let match: RegExpExecArray | null
  while ((match = siRe.exec(xml)) !== null) {
    const texts = [...(match[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((m) =>
      decodeXml(m[1] ?? ''),
    )
    out.push(texts.join(''))
  }
  return out
}

function extractSheetText(xml: string, shared: string[]): string {
  const rows: string[] = []
  for (const row of xml.split(/<\/row>/i)) {
    const cells: string[] = []
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi
    let match: RegExpExecArray | null
    while ((match = cellRe.exec(row)) !== null) {
      const attrs = match[1] ?? ''
      const inner = match[2] ?? ''
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      if (type === 's') {
        const idx = Number(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '')
        cells.push(Number.isInteger(idx) ? (shared[idx] ?? '') : '')
      } else if (type === 'inlineStr') {
        cells.push(decodeXml(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? ''))
      } else {
        cells.push(/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '')
      }
    }
    if (cells.length > 0) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function wantedOfficePath(name: string, ext: OfficeExt): boolean {
  if (ext === '.docx') return name === 'word/document.xml'
  return name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
}

function unzipEntries(buf: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  if (buf.length < 22) throw new Error('short zip')
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let cdOff = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    if (cdOff + 46 > buf.length || buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error('bad cd')
    const method = buf.readUInt16LE(cdOff + 10)
    const compSize = buf.readUInt32LE(cdOff + 20)
    const nameLen = buf.readUInt16LE(cdOff + 28)
    const extraLen = buf.readUInt16LE(cdOff + 30)
    const commentLen = buf.readUInt16LE(cdOff + 32)
    const localOff = buf.readUInt32LE(cdOff + 42)
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString('utf8')
    if (!name.endsWith('/') && wanted(name)) {
      out.set(name, inflateLocal(buf, localOff, method, compSize))
    }
    cdOff += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('no eocd')
}

function inflateLocal(buf: Buffer, localOff: number, method: number, compSize: number): Buffer {
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
    throw new Error('bad local')
  }
  const nameLen = buf.readUInt16LE(localOff + 26)
  const extraLen = buf.readUInt16LE(localOff + 28)
  const dataStart = localOff + 30 + nameLen + extraLen
  if (dataStart + compSize > buf.length) throw new Error('short data')
  const data = buf.subarray(dataStart, dataStart + compSize)
  if (method === 0) {
    if (data.length > MAX_INFLATE) throw new Error('too large')
    return Buffer.from(data)
  }
  if (method === 8) return Buffer.from(inflateRawSync(data, { maxOutputLength: MAX_INFLATE }))
  throw new Error('unsupported method')
}
