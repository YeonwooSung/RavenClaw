export interface NotebookCell {
  id?: string
  cell_type: string
  source: string | string[]
}

export interface Notebook {
  cells: NotebookCell[]
}

export type NotebookEditMode = 'replace' | 'insert' | 'delete'

export interface NotebookEditSpec {
  cell_id?: string
  new_source: string
  cell_type?: string
  edit_mode: NotebookEditMode
}

export function parseNotebook(
  text: string,
): { ok: true; value: Notebook } | { ok: false; message: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON'
    return { ok: false, message }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'notebook must be an object' }
  }
  const rec = raw as Record<string, unknown>
  if (!Array.isArray(rec.cells)) {
    return { ok: false, message: 'notebook.cells must be an array' }
  }
  for (let i = 0; i < rec.cells.length; i++) {
    const cell = rec.cells[i]
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) {
      return { ok: false, message: `cells[${i}] must be an object` }
    }
    const c = cell as Record<string, unknown>
    if (typeof c.cell_type !== 'string' || c.cell_type.length === 0) {
      return { ok: false, message: `cells[${i}] must have cell_type` }
    }
    if (c.id !== undefined && typeof c.id !== 'string') {
      return { ok: false, message: `cells[${i}].id must be a string` }
    }
    if (c.source !== undefined && typeof c.source !== 'string' && !isStringArray(c.source)) {
      return { ok: false, message: `cells[${i}].source must be a string or string[]` }
    }
  }
  return { ok: true, value: raw as Notebook }
}

export function formatNotebookRead(nb: Notebook): string {
  return nb.cells
    .map((cell, index) => {
      const idPart = typeof cell.id === 'string' && cell.id.length > 0 ? ` id=${cell.id}` : ''
      return `## cell ${index} (${cell.cell_type})${idPart}\n${joinSource(cell.source)}`
    })
    .join('\n')
}

export function applyNotebookEdit(
  nb: Notebook,
  edit: NotebookEditSpec,
): { ok: true; cellId?: string; index: number } | { ok: false; message: string } {
  if (edit.edit_mode === 'insert') return insertCell(nb, edit)
  if (edit.edit_mode === 'delete') return deleteCell(nb, edit)
  return replaceCell(nb, edit)
}

export function stringifyNotebook(nb: Notebook, indent: 1 | 2 = 1): string {
  return `${JSON.stringify(nb, null, indent)}\n`
}

export function joinSource(source: string | string[] | undefined): string {
  if (source === undefined) return ''
  return Array.isArray(source) ? source.join('') : source
}

export function toSourceArray(source: string): string[] {
  if (source.length === 0) return []
  const lines = source.split('\n')
  return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\n`))
}

function replaceCell(
  nb: Notebook,
  edit: NotebookEditSpec,
): { ok: true; cellId?: string; index: number } | { ok: false; message: string } {
  const index =
    edit.cell_id !== undefined ? findCellIndex(nb, edit.cell_id) : nb.cells.length - 1
  if (index < 0) {
    return {
      ok: false,
      message:
        edit.cell_id !== undefined ? `cell not found: ${edit.cell_id}` : 'no cells to replace',
    }
  }
  const cell = nb.cells[index]
  if (!cell) return { ok: false, message: 'no cells to replace' }
  cell.source = toSourceArray(edit.new_source)
  if (edit.cell_type !== undefined) cell.cell_type = edit.cell_type
  return { ok: true, cellId: cell.id, index }
}

function insertCell(
  nb: Notebook,
  edit: NotebookEditSpec,
): { ok: true; cellId?: string; index: number } | { ok: false; message: string } {
  let index = 0
  if (edit.cell_id !== undefined) {
    const after = findCellIndex(nb, edit.cell_id)
    if (after < 0) return { ok: false, message: `cell not found: ${edit.cell_id}` }
    index = after + 1
  }
  const id = newCellId()
  const cell: NotebookCell = {
    id,
    cell_type: edit.cell_type ?? 'code',
    source: toSourceArray(edit.new_source),
  }
  nb.cells.splice(index, 0, cell)
  return { ok: true, cellId: id, index }
}

function deleteCell(
  nb: Notebook,
  edit: NotebookEditSpec,
): { ok: true; cellId?: string; index: number } | { ok: false; message: string } {
  if (edit.cell_id === undefined) return { ok: false, message: 'cell_id is required to delete' }
  const index = findCellIndex(nb, edit.cell_id)
  if (index < 0) return { ok: false, message: `cell not found: ${edit.cell_id}` }
  nb.cells.splice(index, 1)
  return { ok: true, cellId: edit.cell_id, index }
}

function findCellIndex(nb: Notebook, cellId: string): number {
  return nb.cells.findIndex((cell) => cell.id === cellId)
}

function newCellId(): string {
  return `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
