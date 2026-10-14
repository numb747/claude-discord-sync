/**
 * Screen parsing against real Claude Code 2.1.273 screens captured from tmux
 * (fixtures/*.txt plain, *.ansi with `capture-pane -e`). Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { dialogOptions, parseKeys, promptOf, screenTail } from '../src/terminal'

const fx = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')

describe('promptOf', () => {
  test('empty input line', () => {
    expect(promptOf(fx('idle.ansi'))).toEqual({ draft: '' })
  })
  test('text typed locally', () => {
    expect(promptOf(fx('draft.ansi'))).toEqual({ draft: 'half typed' })
  })
  test('no input line while a dialog is open', () => {
    expect(promptOf(fx('perm.ansi'))).toBeUndefined()
  })
})

describe('dialogOptions', () => {
  test('tool permission prompt', () => {
    expect(dialogOptions(fx('perm.txt')).map(o => o.label)).toEqual(['Yes', 'Yes, and don’t ask again for: curl *', 'No'])
  })
  test('AskUserQuestion: descriptions and the separated last option', () => {
    expect(dialogOptions(fx('ask.txt')).map(o => o.n + ' ' + o.label)).toEqual([
      '1 Red',
      '2 Green',
      '3 Blue',
      '4 Type something.',
      '5 Chat about this',
    ])
  })
  test("plan approval, not the plan's own numbered steps", () => {
    expect(dialogOptions(fx('plan.txt')).map(o => o.label)).toEqual([
      'Yes, auto-accept edits',
      'Yes, manually approve edits',
      'Tell Claude what to change',
    ])
  })
  test('nothing on an idle screen', () => {
    expect(dialogOptions(fx('idle.ansi').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ''))).toEqual([])
  })
})

test('screenTail drops blank lines and rules', () => {
  const tail = screenTail(fx('perm.txt'), 5)
  expect(tail.split('\n')).toHaveLength(5)
  expect(tail).not.toMatch(/^\s*─+\s*$/m)
  expect(tail).toContain('Esc to cancel')
})

describe('parseKeys', () => {
  test('named keys and single characters', () => {
    expect(parseKeys('down down Enter')).toEqual([['Down'], ['Down'], ['Enter']])
    expect(parseKeys('2')).toEqual([['-l', '2']])
    expect(parseKeys('stab esc c-c')).toEqual([['BTab'], ['Escape'], ['C-c']])
  })
  test('refuses anything else', () => {
    expect(parseKeys('')).toBeUndefined()
    expect(parseKeys('rm -rf')).toBeUndefined()
    expect(parseKeys('ab')).toBeUndefined()
    expect(parseKeys(Array(13).fill('down').join(' '))).toBeUndefined()
  })
})
