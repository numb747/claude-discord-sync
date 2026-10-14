/**
 * Screen parsing against real Claude Code 2.1.273 screens captured from tmux
 * (fixtures/*.txt plain, *.ansi with `capture-pane -e`), and 2.1.299 screens
 * (*-cursor.ansi) with tmux's cursor position. Run with `bun test`.
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
  test('2.1.299: empty input line, hint not taken for a draft', () => {
    expect(promptOf(fx('idle-cursor.ansi'), { x: 2, y: 36 })).toEqual({ draft: '' })
  })
  test('2.1.299: text typed locally, CJK counted as two columns', () => {
    expect(promptOf(fx('draft-cursor.ansi'), { x: 21, y: 36 })).toEqual({ draft: '写了一半 half typed' })
  })
  test('2.1.299: text after the cursor is part of the draft (cursor moved back with ← or Home)', () => {
    expect(promptOf(fx('draft-cursor.ansi'), { x: 6, y: 36 })).toEqual({ draft: '写了一半 half typed' })
    expect(promptOf(fx('draft-cursor.ansi'), { x: 2, y: 36 })).toEqual({ draft: '写了一半 half typed' })
  })
  test('2.1.299: multi-line draft', () => {
    expect(promptOf(fx('multiline-cursor.ansi'), { x: 23, y: 36 })).toEqual({ draft: '第一行\n2. second line 第二行' })
    expect(promptOf(fx('multiline-cursor.ansi'), { x: 2, y: 35 })).toEqual({ draft: '第一行\n2. second line 第二行' })
  })
  test('2.1.299: dimmed text after the draft (a suggestion) is not part of it; coloured text is', () => {
    const screen = fx('draft-cursor.ansi').replace(' half typed', ' half \x1b[38;5;2mtyped\x1b[39m\x1b[2m suggested\x1b[0m')
    expect(promptOf(screen, { x: 21, y: 36 })).toEqual({ draft: '写了一半 half typed' })
  })
  test('cursor drawn in the middle of the draft', () => {
    const screen = fx('draft.ansi').replace('half typed\x1b[7m \x1b[0m', 'half\x1b[7m \x1b[0mtyped')
    expect(promptOf(screen)).toEqual({ draft: 'half typed' })
  })
  test('2.1.299: no input line without the cursor in the box', () => {
    expect(promptOf(fx('idle-cursor.ansi'))).toBeUndefined()
    expect(promptOf(fx('idle-cursor.ansi'), { x: 0, y: 39 })).toBeUndefined()
  })
  test('a multi-line prompt put back after an interruption', () => {
    expect(promptOf(fx('restored.ansi'))).toEqual({
      draft:
        '请帮我写一个很长的故事，主题是星际旅行，要求：\n1. 至少五千字\n2. 有三个主要角色，每个角色都要有完整的背景故事和性格描写，并且角色之间要有冲突和和解的过程，结尾要出人意料但是合理',
    })
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
