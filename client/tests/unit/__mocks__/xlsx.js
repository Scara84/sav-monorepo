// Mock pour la bibliothèque xlsx (Vitest)
import { vi } from 'vitest'

export const utils = {
  json_to_sheet: () => ({
    '!ref': 'A1:Z100',
    '!cols': [],
    '!rows': [],
    '!merges': [],
  }),
  book_new: () => ({}),
  book_append_sheet: (wb, ws, name) => {
    wb.SheetNames = wb.SheetNames || []
    wb.Sheets = wb.Sheets || {}
    wb.SheetNames.push(name)
    wb.Sheets[name] = ws
    return wb
  },
  write: () => {
    return new Uint8Array(0)
  },
}

const xlsx = {
  utils,
  writeFile: vi.fn(),
  writeFileXLSX: vi.fn(),
}

export default xlsx
