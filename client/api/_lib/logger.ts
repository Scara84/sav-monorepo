// Logger structuré JSON, stdout only (cap. Vercel dashboard).
// Champs standards : ts, level, msg, requestId, path, userId?, role?, ms?, status?

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  requestId?: string
  path?: string
  userId?: number | string
  role?: string
  ms?: number
  status?: number
  [key: string]: unknown
}

function emit(level: LogLevel, msg: string, fields: LogFields): void {
  const record = { ts: new Date().toISOString(), level, msg, ...fields }
  const stream = level === 'error' || level === 'warn' ? console.error : console.log
  stream(JSON.stringify(record))
}

export const logger = {
  debug: (msg: string, fields: LogFields = {}): void => emit('debug', msg, fields),
  info: (msg: string, fields: LogFields = {}): void => emit('info', msg, fields),
  warn: (msg: string, fields: LogFields = {}): void => emit('warn', msg, fields),
  error: (msg: string, fields: LogFields = {}): void => emit('error', msg, fields),
}
