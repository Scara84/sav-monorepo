import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { createClaimWorkbook, type ClaimWriterInput } from './supplier-claim-workbook'

export * from './supplier-claim-workbook'

export interface ClaimWorkbookResult {
  blob: Buffer
  sha256: string
  filename: string
}

export function buildClaimWorkbook(input: ClaimWriterInput): ClaimWorkbookResult {
  const { workbook, filename } = createClaimWorkbook(input)
  const blob = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const sha256 = createHash('sha256').update(blob).digest('hex')
  return { blob, sha256, filename }
}
