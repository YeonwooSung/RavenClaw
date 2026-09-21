export function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const start = value[0]
    const end = value[value.length - 1]
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export function parseYamlMap(text: string): Record<string, YamlValue> {
  const lines = text.split(/\r?\n/)
  const { value } = parseYamlBlock(lines, 0, 0)
  return value
}

function parseYamlBlock(
  lines: string[],
  start: number,
  minIndent: number,
): { value: Record<string, YamlValue>; next: number } {
  const out: Record<string, YamlValue> = {}
  let i = start
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) {
      i++
      continue
    }
    const indent = leadingSpaces(raw)
    if (indent < minIndent) break
    const parsed = parseKeyedLine(raw.slice(indent))
    if (!parsed) {
      i++
      continue
    }
    i++
    if (parsed.value === undefined) {
      const next = nextMeaningful(lines, i)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > indent) {
        const nested = parseYamlNested(lines, i, nextIndent)
        out[parsed.key] = nested.value
        i = nested.next
      } else {
        out[parsed.key] = null
      }
    } else {
      out[parsed.key] = parsed.value
    }
  }
  return { value: out, next: i }
}

function parseKeyedLine(content: string): { key: string; value: YamlValue | undefined } | undefined {
  const trimmed = stripYamlComment(content).trim()
  if (trimmed === '') return undefined
  const keyMatch = trimmed.match(/^(?:"([^"]*)"|'([^']*)'|([^:#{}[\],]+?))\s*:(\s+.*)?$/)
  if (!keyMatch) return undefined
  const key = keyMatch[1] ?? keyMatch[2] ?? (keyMatch[3] ?? '').trim()
  if (key === '') return undefined
  const rest = (keyMatch[4] ?? '').trim()
  if (rest === '') return { key, value: undefined }
  return { key, value: parseYamlScalar(rest) }
}

function parseYamlNested(
  lines: string[],
  start: number,
  minIndent: number,
): { value: YamlValue; next: number } {
  const next = nextMeaningful(lines, start)
  if (next === undefined) return { value: null, next: start }
  const indent = leadingSpaces(lines[next] ?? '')
  if (indent < minIndent) return { value: null, next: start }
  const content = (lines[next] ?? '').slice(indent)
  if (isYamlListItem(content)) return parseYamlList(lines, start, indent)
  return parseYamlBlock(lines, start, indent)
}

function parseYamlList(
  lines: string[],
  start: number,
  minIndent: number,
): { value: YamlValue[]; next: number } {
  const out: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) {
      i++
      continue
    }
    const indent = leadingSpaces(raw)
    if (indent < minIndent) break
    if (indent > minIndent) {
      i++
      continue
    }
    const content = raw.slice(indent)
    if (!isYamlListItem(content)) break
    const rest = content.replace(/^-/, '').trim()
    i++
    if (rest === '') {
      const next = nextMeaningful(lines, i)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > indent) {
        const nested = parseYamlNested(lines, i, nextIndent)
        out.push(nested.value)
        i = nested.next
      } else {
        out.push(null)
      }
      continue
    }
    const keyed = parseKeyedLine(rest)
    if (keyed) {
      const item: Record<string, YamlValue> = {}
      if (keyed.value === undefined) {
        const next = nextMeaningful(lines, i)
        const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
        if (next !== undefined && nextIndent > indent) {
          const nested = parseYamlNested(lines, i, nextIndent)
          item[keyed.key] = nested.value
          i = nested.next
        } else {
          item[keyed.key] = null
        }
      } else {
        item[keyed.key] = keyed.value
      }
      const siblings = parseYamlBlock(lines, i, indent + 1)
      Object.assign(item, siblings.value)
      i = siblings.next
      out.push(item)
    } else {
      out.push(parseYamlScalar(rest))
    }
  }
  return { value: out, next: i }
}

function isYamlListItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

function parseYamlScalar(raw: string): YamlValue {
  const text = stripYamlComment(raw).trim()
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') {
    return null
  }
  if (text === 'true' || text === 'True' || text === 'TRUE') return true
  if (text === 'false' || text === 'False' || text === 'FALSE') return false
  if (text.startsWith('{') && text.endsWith('}')) {
    return parseInlineMap(text)
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return parseInlineList(text)
  }
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    return Number(text)
  }
  return text
}

function parseInlineList(text: string): YamlValue[] {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  const out: YamlValue[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === ',')) i++
    if (i >= inner.length) break
    const valuePart = readInlineValue(inner, i)
    out.push(valuePart.value)
    i = valuePart.next
  }
  return out
}

function parseInlineMap(text: string): Record<string, YamlValue> {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return {}
  const out: Record<string, YamlValue> = {}
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === ' ' || inner[i] === ',')) i++
    if (i >= inner.length) break
    const keyPart = readInlineKey(inner, i)
    i = keyPart.next
    while (i < inner.length && inner[i] === ' ') i++
    if (inner[i] !== ':') break
    i++
    while (i < inner.length && inner[i] === ' ') i++
    const valuePart = readInlineValue(inner, i)
    out[keyPart.key] = valuePart.value
    i = valuePart.next
  }
  return out
}

function readInlineKey(text: string, start: number): { key: string; next: number } {
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start]
    let i = start + 1
    while (i < text.length && text[i] !== quote) i++
    return { key: text.slice(start + 1, i), next: i < text.length ? i + 1 : i }
  }
  let i = start
  while (i < text.length && text[i] !== ':' && text[i] !== ',') i++
  return { key: text.slice(start, i).trim(), next: i }
}

function readInlineValue(
  text: string,
  start: number,
): { value: YamlValue; next: number } {
  if (text[start] === '{') {
    let depth = 0
    let i = start
    while (i < text.length) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          return { value: parseInlineMap(text.slice(start, i + 1)), next: i + 1 }
        }
      }
      i++
    }
    return { value: parseInlineMap(text.slice(start)), next: text.length }
  }
  if (text[start] === '[') {
    let depth = 0
    let i = start
    while (i < text.length) {
      if (text[i] === '[') depth++
      else if (text[i] === ']') {
        depth--
        if (depth === 0) {
          return { value: parseInlineList(text.slice(start, i + 1)), next: i + 1 }
        }
      }
      i++
    }
    return { value: parseInlineList(text.slice(start)), next: text.length }
  }
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start]
    let i = start + 1
    while (i < text.length && text[i] !== quote) i++
    const end = i < text.length ? i + 1 : i
    return { value: parseYamlScalar(text.slice(start, end)), next: end }
  }
  let i = start
  while (i < text.length && text[i] !== ',') i++
  return { value: parseYamlScalar(text.slice(start, i)), next: i }
}

function stripYamlComment(text: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t') {
        return text.slice(0, i)
      }
    }
  }
  return text
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function leadingSpaces(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function nextMeaningful(lines: string[], start: number): number | undefined {
  for (let i = start; i < lines.length; i++) {
    if (!isBlankOrComment(lines[i] ?? '')) return i
  }
  return undefined
}

export function upsertYamlTopLevelScalar(text: string, key: string, value: string): string {
  if (text === '') return `${key}: ${value}\n`
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let found = -1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (isBlankOrComment(raw)) continue
    if (leadingSpaces(raw) !== 0) continue
    const parsed = parseKeyedLine(raw)
    if (!parsed || parsed.key !== key) continue
    found = i
    if (parsed.value === undefined) {
      const next = nextMeaningful(lines, i + 1)
      const nextIndent = next === undefined ? -1 : leadingSpaces(lines[next] ?? '')
      if (next !== undefined && nextIndent > 0) throw new Error(`${key} is not a scalar`)
    } else if (parsed.value !== null && typeof parsed.value === 'object') {
      throw new Error(`${key} is not a scalar`)
    }
    break
  }
  const replacement = `${key}: ${value}`
  if (found >= 0) lines[found] = replacement
  else lines.push(replacement)
  return `${lines.join(newline)}${newline}`
}
