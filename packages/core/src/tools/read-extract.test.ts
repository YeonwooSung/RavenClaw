import { describe, expect, test } from 'bun:test'
import { extractOfficeText } from './read-extract'

describe('extractOfficeText', () => {
  test('extracts docx paragraph text from document.xml', () => {
    const buf = zipStore({
      'word/document.xml':
        '<w:document><w:body><w:p><w:t>Hello</w:t><w:t> world</w:t></w:p><w:p><w:t>Next</w:t></w:p></w:body></w:document>',
    })
    const out = extractOfficeText(buf, '.docx')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text).toBe('Hello world\nNext')
  })

  test('extracts xlsx shared strings and numeric cells', () => {
    const buf = zipStore({
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>42</v></c></row></sheetData></worksheet>',
    })
    const out = extractOfficeText(buf, '.xlsx')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text).toBe('Name\tAda\n42')
  })

  test('malformed zip fails closed', () => {
    expect(extractOfficeText(Buffer.from('not a zip'), '.docx').ok).toBe(false)
    expect(extractOfficeText(zipStore({ 'xl/workbook.xml': '<x/>' }), '.xlsx').ok).toBe(false)
  })

  test('skips unused zip entries and refuses oversized document.xml', () => {
    const huge = 'x'.repeat(2_000_001)
    const kept = extractOfficeText(
      zipStore({
        'word/document.xml': '<w:p><w:t>keep</w:t></w:p>',
        'word/media/image1.bin': huge,
      }),
      '.docx',
    )
    expect(kept.ok).toBe(true)
    if (kept.ok) expect(kept.text).toBe('keep')
    expect(extractOfficeText(zipStore({ 'word/document.xml': huge }), '.docx').ok).toBe(false)
  })
})

function zipStore(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const piece = Buffer.concat([local, nameBuf, data])
    locals.push(piece)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += piece.length
  }
  const localAll = Buffer.concat(locals)
  const centralAll = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralAll.length, 12)
  eocd.writeUInt32LE(localAll.length, 16)
  return Buffer.concat([localAll, centralAll, eocd])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
