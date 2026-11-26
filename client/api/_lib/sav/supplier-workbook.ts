import * as XLSX from 'xlsx'
import { SaxesParser } from 'saxes'
import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js'

export const MAX_FILE_SIZE = 4 * 1024 * 1024
const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export function hasXlsxMagicBytes(buffer: Buffer) {
  return buffer.subarray(0, zipMagic.length).equals(zipMagic)
}

export function readSupplierWorkbook(buffer: Buffer) {
  return XLSX.read(buffer, {
    type: 'buffer', cellFormula: true, cellHTML: false, cellNF: false, cellText: false, raw: true,
  })
}

const typesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const spreadsheetNamespaces = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
])
const mainType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'

function inspectXml(data: Buffer, manifest: boolean, expectedRoots: Map<string, string>) {
  const encoding = data[0] === 0xff || data[1] === 0 ? 'utf-16le' :
    data[0] === 0xfe || data[0] === 0 ? 'utf-16be' : 'utf-8'
  const parser = new SaxesParser({ xmlns: true })
  let root: { name: string; namespace: string } | undefined
  parser.on('opentag', tag => {
    root ??= { name: tag.local, namespace: tag.uri }
    if (!manifest || tag.uri !== typesNamespace || tag.local !== 'Override') return
    const type = tag.attributes.ContentType?.value
    if (type !== mainType && type !== sheetType) return
    const part = tag.attributes.PartName?.value
    if (!part?.startsWith('/') || expectedRoots.has(part.slice(1))) throw new Error('Partie XLSX ambiguë.')
    expectedRoots.set(part.slice(1), type === mainType ? 'workbook' : 'worksheet')
  })
  parser.write(new TextDecoder(encoding, { fatal: true }).decode(data)).close()
  if (!root || (manifest && (root.name !== 'Types' || root.namespace !== typesNamespace)))
    throw new Error('XML incorrect.')
  return root
}

export async function validateOriginalWorkbook(buffer: Buffer, signal: AbortSignal) {
  if (buffer.length > MAX_FILE_SIZE || !hasXlsxMagicBytes(buffer)) throw new Error('Format incorrect.')
  const reader = new ZipReader(new Uint8ArrayReader(buffer), { useWebWorkers: false, strictness: 'strict' })
  const names = new Set<string>()
  const expectedRoots = new Map<string, string>()
  const roots = new Map<string, ReturnType<typeof inspectXml>>()
  // Borner également la décompression avant de confier les données à SheetJS.
  let remaining = 64 * 1024 * 1024
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (names.has(entry.filename)) throw new Error('Entrée ZIP ambiguë.')
      names.add(entry.filename)
      if (entry.directory) continue
      if (entry.encrypted || entry.uncompressedSize > remaining) throw new Error('Archive invalide.')
      const manifest = entry.filename === '[Content_Types].xml'
      const xml = /\.(?:xml|rels)$/i.test(entry.filename)
      const chunks: Buffer[] = []
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          remaining -= chunk.byteLength
          if (remaining < 0) throw new Error('Archive trop volumineuse.')
          if (xml) chunks.push(Buffer.from(chunk))
        },
      }), { signal, checkCrc32: true, checkOverlappingEntry: true })
      if (xml) roots.set(entry.filename, inspectXml(Buffer.concat(chunks), manifest, expectedRoots))
    }
  } finally {
    await reader.close()
  }
  let workbooks = 0
  for (const [part, expected] of expectedRoots) {
    const root = roots.get(part)
    if (root?.name !== expected || !spreadsheetNamespaces.has(root.namespace)) throw new Error('Partie XLSX incorrecte.')
    if (expected === 'workbook') workbooks++
  }
  if (workbooks !== 1) throw new Error('Format XLSX incorrect.')
  const workbook = readSupplierWorkbook(buffer)
  if (workbook.bookType !== 'xlsx' || !workbook.SheetNames.length ||
      workbook.SheetNames.some(name => !Object.hasOwn(workbook.Sheets, name)))
    throw new Error('Classeur illisible.')
}
