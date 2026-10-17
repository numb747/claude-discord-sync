/**
 * Screen parsing against real Claude Code 2.1.273 screens captured from tmux
 * (fixtures/*.txt plain, *.ansi with `capture-pane -e`), and 2.1.299 screens
 * (*-cursor.ansi) with tmux's cursor position; pasted-cursor.ansi is 2.1.302.
 * Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { agentList, dialogOptions, draftIsMessage, hasPromptBox, keyBackToLeader, onAgentView, parseKeys, promptOf, screenTail } from '../src/terminal'

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
  test('2.1.302: a long paste put back after an interruption is collapsed', () => {
    expect(promptOf(fx('pasted-cursor.ansi'), { x: 28, y: 45 })).toEqual({ draft: '[Pasted text #4 +13 lines]' })
  })
})

describe('draftIsMessage', () => {
  const notes = ['[Discord · alice (collaborator)] please read these notes', ...Array.from({ length: 12 }, (_, i) => `note ${i + 1}`), 'then write a poem'].join('\n')
  test('the same text, wrapped differently', () => {
    expect(draftIsMessage('写一首关于 河流的诗', '写一首关于河流的\n诗')).toBe(true)
    expect(draftIsMessage('写一首关于河流的诗', '写一首关于山的诗')).toBe(false)
  })
  test('a collapsed paste stands for as many lines as it says', () => {
    expect(draftIsMessage('[Pasted text #4 +13 lines]', notes)).toBe(true)
    expect(draftIsMessage('[Pasted text #4 +12 lines]', notes)).toBe(false)
    expect(draftIsMessage('[Pasted text #4 +13 lines]', 'short')).toBe(false)
  })
  test('text typed around a paste has to match too', () => {
    expect(draftIsMessage('read this[Pasted text #2 +13 lines]', `read this\n\n${notes}`)).toBe(true)
    expect(draftIsMessage('read that[Pasted text #2 +13 lines]', `read this\n\n${notes}`)).toBe(false)
  })
  test('regex characters in the draft are literal', () => {
    expect(draftIsMessage('a.b (c) [d]', 'a.b (c) [d]')).toBe(true)
    expect(draftIsMessage('a.b', 'axb')).toBe(false)
  })
})

// agents-*.ansi: 2.1.273 with a background agent running, after the keys named in each test.
describe('agentList / keyBackToLeader', () => {
  test('main session on view, box has the keyboard: nothing to do', () => {
    expect(agentList(fx('agents-idle.ansi'))).toEqual({ names: ['main', 'general-purpose'], viewing: 0 })
    expect(keyBackToLeader(fx('agents-idle.ansi'))).toBeUndefined()
  })
  test('no agents, or a dialog: nothing to do', () => {
    for (const f of ['idle.ansi', 'draft.ansi', 'perm.ansi', 'idle-cursor.ansi']) {
      expect(agentList(fx(f))).toBeUndefined()
      expect(keyBackToLeader(fx(f))).toBeUndefined()
    }
  })
  test('↓: the list has the keyboard, on the main session', () => {
    expect(agentList(fx('agents-list-focused.ansi'))).toEqual({ names: ['main', 'general-purpose'], viewing: 0, selected: 0 })
    expect(keyBackToLeader(fx('agents-list-focused.ansi'))).toBe('Up')
  })
  test('↓ ↓ Enter: viewing the agent, list still has the keyboard', () => {
    expect(agentList(fx('agents-viewing-agent.ansi'))).toEqual({ names: ['main', 'general-purpose'], viewing: 1, selected: 1 })
    expect(keyBackToLeader(fx('agents-viewing-agent.ansi'))).toBe('Up')
  })
  test('↓ ↓ Enter ↑ ↑: viewing the agent with the box ("Message @…") taking input', () => {
    expect(agentList(fx('agents-viewing-agent-box.ansi'))).toEqual({ names: ['main', 'general-purpose'], viewing: 1 })
    expect(keyBackToLeader(fx('agents-viewing-agent-box.ansi'))).toBe('Down')
  })
  test('then ↓ selects the main session, Enter views it, ↑ gives the box the keyboard', () => {
    const selectedMain = fx('agents-viewing-agent-box.ansi').replace('  ◯ main', '❯ ◯ main')
    expect(keyBackToLeader(selectedMain)).toBe('Enter')
    expect(keyBackToLeader(fx('agents-back-on-main.ansi'))).toBe('Up')
  })
  test('← on an empty box: the background dialog is cancelled', () => {
    expect(keyBackToLeader(fx('agents-background-dialog.ansi'))).toBe('Escape')
  })
})

describe('onAgentView', () => {
  test('true only while the box is addressed to an agent ("Message @…")', () => {
    expect(onAgentView(fx('agents-viewing-agent.ansi'))).toBe(true)
    expect(onAgentView(fx('agents-viewing-agent-box.ansi'))).toBe(true)
  })
  test('false on the main session, the list, a dialog, or a plain box', () => {
    for (const f of ['agents-idle.ansi', 'agents-list-focused.ansi', 'agents-back-on-main.ansi', 'idle.ansi', 'draft.ansi', 'perm.ansi']) {
      expect(onAgentView(fx(f))).toBe(false)
    }
  })
  test('still detected when a trailing status line leaves agentList unable to parse', () => {
    // A long list or a line below it can defeat agentList (and so keyBackToLeader);
    // the box line still gives it away, so backToLeader reports it instead of typing there.
    const screen = fx('agents-viewing-agent-box.ansi') + '\n  running 3 agents · ↓ to manage\n'
    expect(agentList(screen)).toBeUndefined()
    expect(keyBackToLeader(screen)).toBeUndefined()
    expect(onAgentView(screen)).toBe(true)
  })
})

describe('hasPromptBox', () => {
  test('true when the box is drawn, even without the cursor (lost focus)', () => {
    expect(hasPromptBox(fx('idle.ansi'))).toBe(true)
    expect(hasPromptBox(fx('draft.ansi'))).toBe(true)
    expect(hasPromptBox(fx('agents-viewing-agent-box.ansi'))).toBe(true)
    // 2.1.299 hides the cursor on lost focus; promptOf reads no input line, the box is still there.
    expect(promptOf(fx('idle-cursor.ansi'))).toBeUndefined()
    expect(hasPromptBox(fx('idle-cursor.ansi'))).toBe(true)
  })
  test('false when a dialog or menu is open, so focus is not nudged at it', () => {
    expect(hasPromptBox(fx('perm.ansi'))).toBe(false)
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
