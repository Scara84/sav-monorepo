import { describe, it, expect } from 'vitest'
import {
  isTransitionAllowed,
  getAllowedTransitions,
} from '../../../api/_lib/business/sav-status-machine'

describe('sav-status-machine', () => {
  it('transitions valides — draft → received, cancelled', () => {
    expect(isTransitionAllowed('draft', 'received')).toBe(true)
    expect(isTransitionAllowed('draft', 'cancelled')).toBe(true)
    expect(isTransitionAllowed('draft', 'validated')).toBe(false)
  })

  it('transitions valides — received → in_progress, cancelled', () => {
    expect(isTransitionAllowed('received', 'in_progress')).toBe(true)
    expect(isTransitionAllowed('received', 'cancelled')).toBe(true)
    expect(isTransitionAllowed('received', 'validated')).toBe(false)
  })

  it('in_progress → rollback received autorisé', () => {
    expect(isTransitionAllowed('in_progress', 'received')).toBe(true)
    expect(isTransitionAllowed('in_progress', 'validated')).toBe(true)
    expect(isTransitionAllowed('in_progress', 'cancelled')).toBe(true)
    expect(isTransitionAllowed('in_progress', 'draft')).toBe(false)
  })

  it('validated → closed, cancelled', () => {
    expect(isTransitionAllowed('validated', 'closed')).toBe(true)
    expect(isTransitionAllowed('validated', 'cancelled')).toBe(true)
    expect(isTransitionAllowed('validated', 'received')).toBe(false)
  })

  it('closed et cancelled terminaux', () => {
    expect(getAllowedTransitions('closed')).toEqual([])
    expect(getAllowedTransitions('cancelled')).toEqual([])
  })

  it('getAllowedTransitions retourne une copie mutable', () => {
    const arr = getAllowedTransitions('draft')
    arr.push('closed' as never)
    // L'interne ne doit pas être pollué
    expect(getAllowedTransitions('draft')).not.toContain('closed')
  })
})
