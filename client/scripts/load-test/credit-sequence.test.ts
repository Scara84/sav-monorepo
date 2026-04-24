// Story 4.6 AC #9 — tests unitaires des helpers purs du script load test.
// Exclut seed / RPC / cleanup (couverts par run manuel).

import { describe, it, expect } from 'vitest'

import {
  parseCliArgs,
  guardAgainstProd,
  computeLatencyPercentiles,
  runWithConcurrency,
} from './credit-sequence'

describe('parseCliArgs', () => {
  it('returns defaults when no args', () => {
    expect(parseCliArgs([])).toEqual({
      count: 10_000,
      concurrency: 100,
      cleanup: true,
      dryRun: false,
      cleanupOnly: false,
    })
  })

  it('parses --count and --concurrency', () => {
    const r = parseCliArgs(['--count=1000', '--concurrency=50'])
    expect(r.count).toBe(1000)
    expect(r.concurrency).toBe(50)
  })

  it('parses --cleanup=false', () => {
    expect(parseCliArgs(['--cleanup=false']).cleanup).toBe(false)
  })

  it('parses --dry-run flag', () => {
    expect(parseCliArgs(['--dry-run']).dryRun).toBe(true)
  })

  it('parses --cleanup-only flag', () => {
    expect(parseCliArgs(['--cleanup-only']).cleanupOnly).toBe(true)
  })

  it('throws on --count=abc', () => {
    expect(() => parseCliArgs(['--count=abc'])).toThrow(/Invalid --count/)
  })

  it('throws on negative --count', () => {
    expect(() => parseCliArgs(['--count=-5'])).toThrow(/Invalid --count/)
  })

  it('throws on non-integer --concurrency', () => {
    expect(() => parseCliArgs(['--concurrency=3.5'])).toThrow(/Invalid --concurrency/)
  })

  it('throws on unknown flag', () => {
    expect(() => parseCliArgs(['--whatever'])).toThrow(/Unknown argument/)
  })

  it('throws on positional argument', () => {
    expect(() => parseCliArgs(['foo'])).toThrow(/Unknown positional/)
  })

  it('throws when --dry-run carries a value', () => {
    expect(() => parseCliArgs(['--dry-run=something'])).toThrow(/does not take a value/)
  })

  it('throws on --cleanup=maybe', () => {
    expect(() => parseCliArgs(['--cleanup=maybe'])).toThrow(/expected true\|false/)
  })

  it('throws on --count above MAX_COUNT cap', () => {
    expect(() => parseCliArgs(['--count=9999999'])).toThrow(/Invalid --count/)
  })

  it('throws on --count=Infinity', () => {
    expect(() => parseCliArgs(['--count=Infinity'])).toThrow(/Invalid --count/)
  })

  it('rejects --cleanup-only combined with --dry-run', () => {
    expect(() => parseCliArgs(['--cleanup-only', '--dry-run'])).toThrow(/mutually exclusive/)
  })
})

describe('guardAgainstProd', () => {
  it('accepts preview URLs', () => {
    expect(() => guardAgainstProd('https://abcdefghij.supabase.co')).not.toThrow()
  })

  it('accepts URL with "prod" as inner substring (reprod-feature)', () => {
    // Word-boundary — « reprod » n'a pas de boundary avant « prod ».
    expect(() => guardAgainstProd('https://reprod-feature.supabase.co')).not.toThrow()
  })

  it('blocks URL containing "-prod-" token', () => {
    expect(() => guardAgainstProd('https://my-prod-db.supabase.co')).toThrow(
      /contains a 'prod\|production' token/
    )
  })

  it('blocks URL containing "production" case-insensitive', () => {
    expect(() => guardAgainstProd('https://PRODUCTION.supabase.co')).toThrow(
      /contains a 'prod\|production' token/
    )
  })

  it('blocks empty URL', () => {
    expect(() => guardAgainstProd('')).toThrow(/empty/)
  })

  it('rejects invalid URL', () => {
    expect(() => guardAgainstProd('not-a-url')).toThrow(/not a valid URL/)
  })
})

describe('computeLatencyPercentiles', () => {
  it('returns zeros on empty input', () => {
    expect(computeLatencyPercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
  })

  it('computes percentiles on a linear distribution', () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    const r = computeLatencyPercentiles(durations)
    expect(r.p50).toBe(50)
    expect(r.p95).toBe(95)
    expect(r.p99).toBe(99)
    expect(r.max).toBe(100)
  })

  it('handles single-element input', () => {
    expect(computeLatencyPercentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42, max: 42 })
  })

  it('sorts unsorted input', () => {
    const r = computeLatencyPercentiles([100, 1, 50, 25, 75])
    expect(r.max).toBe(100)
    expect(r.p50).toBe(50)
  })
})

describe('runWithConcurrency', () => {
  it('preserves input order in results', async () => {
    const tasks = [1, 2, 3, 4, 5].map((v) => async () => {
      // Petit délai asymétrique pour prouver que l'ordre ne dépend pas du
      // temps d'achèvement.
      await new Promise((r) => setTimeout(r, (5 - v) * 5))
      return v
    })
    const r = await runWithConcurrency(tasks, 3)
    expect(r).toEqual([1, 2, 3, 4, 5])
  })

  it('respects max concurrency', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 20 }, () => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return null
    })
    await runWithConcurrency(tasks, 4)
    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it('handles empty task list', async () => {
    expect(await runWithConcurrency([], 5)).toEqual([])
  })

  it('throws on invalid concurrency (zero)', async () => {
    await expect(runWithConcurrency([async () => 1], 0)).rejects.toThrow(/Invalid concurrency/)
  })

  it('throws on non-integer concurrency (NaN)', async () => {
    await expect(runWithConcurrency([async () => 1], NaN)).rejects.toThrow(/Invalid concurrency/)
  })

  it('throws on non-integer concurrency (3.5)', async () => {
    await expect(runWithConcurrency([async () => 1], 3.5)).rejects.toThrow(/Invalid concurrency/)
  })

  it('propagates first task error and aborts remaining tasks', async () => {
    let started = 0
    const tasks = Array.from({ length: 50 }, (_, i) => async () => {
      started++
      if (i === 1) {
        throw new Error('boom')
      }
      await new Promise((r) => setTimeout(r, 10))
      return i
    })
    await expect(runWithConcurrency(tasks, 5)).rejects.toThrow(/boom/)
    // Abort flag → les tâches au-delà de la concurrency + 1 ne démarrent pas.
    expect(started).toBeLessThan(50)
  })
})
