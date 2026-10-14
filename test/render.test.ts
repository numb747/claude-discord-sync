/**
 * What reaches Discord: Markdown it can't render, tool lines and permission
 * previews. Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test'
import { discordify } from '../src/markdown'
import { toolPreview, cardEmbed } from '../src/cards'
import { toolLabel } from '../src/render'
import { setLanguage } from '../src/i18n'

setLanguage('en')

describe('discordify', () => {
  test('two-column table becomes a list', () => {
    const md = ['Intro', '', '| Key | Meaning |', '|---|---|', '| `a` | first |', '| **b** | second |', '', 'After'].join('\n')
    expect(discordify(md)).toBe(['Intro', '', '- **`a`** — first', '- **b** — second', '', 'After'].join('\n'))
  })
  test('wider table: first cell, then header: value', () => {
    const md = ['| Name | When | How |', '| :-- | --- | --: |', '| one | now | fast |', '| two |  | slow |'].join('\n')
    expect(discordify(md)).toBe(['- **one**', '  - When: now', '  - How: fast', '- **two**', '  - How: slow'].join('\n'))
  })
  test('Chinese headers get a full-width colon', () => {
    expect(discordify(['| 机制 | 删哪些 | 何时 |', '|---|---|---|', '| 上限 | 最早的 | 490 个 |'].join('\n'))).toBe(
      ['- **上限**', '  - 删哪些：最早的', '  - 何时：490 个'].join('\n'),
    )
  })
  test('a table without a first header keeps its row labels', () => {
    const md = ['| | Value |', '|---|---|', '| x | 1 |'].join('\n')
    expect(discordify(md)).toBe('- **x** — 1')
  })
  test('pipes escaped inside a cell stay', () => {
    expect(discordify(['| a | b |', '|---|---|', '| x \\| y | z |'].join('\n'))).toBe('- **x | y** — z')
  })
  test('code blocks are left alone', () => {
    const md = ['```', '| a | b |', '|---|---|', '#### not a heading', '---', '```'].join('\n')
    expect(discordify(md)).toBe(md)
  })
  test('deep headings and rules', () => {
    expect(discordify(['#### Detail', 'text', '---', '## Kept'].join('\n'))).toBe(['**Detail**', 'text', '## Kept'].join('\n'))
  })
  test('a pipe line that is not a table is kept', () => {
    expect(discordify('| just a line |')).toBe('| just a line |')
  })
})

describe('toolLabel', () => {
  test('a multi-line command shows its first line', () => {
    expect(toolLabel('Bash', { command: "python3 - <<'EOF'\nprint(1)\nEOF" })).toBe("**Bash** `python3 - <<'EOF'` … (3 lines)")
  })
  test('a one-line command is unchanged', () => {
    expect(toolLabel('Bash', { command: 'npm test' })).toBe('**Bash** `npm test`')
  })
})

describe('toolPreview', () => {
  test('Bash: the command', () => {
    expect(toolPreview('Bash', { command: 'rm -rf build', description: 'Clean' })).toBe('```bash\nrm -rf build\n```')
  })
  test('Write: path and content with its language, not JSON', () => {
    const out = toolPreview('Write', { file_path: '/p/a.ts', content: 'const x = 1\nconst y = 2\n' })
    expect(out).toBe('📄 `/p/a.ts`\n```ts\nconst x = 1\nconst y = 2\n```')
    expect(out).not.toContain('\\n')
  })
  test('Write: long content is cut with a line count', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const out = toolPreview('Write', { file_path: '/p/a.txt', content })
    expect(out).toContain('line 19')
    expect(out).not.toContain('line 20')
    expect(out).toContain('… (30 lines)')
  })
  test('Edit: a diff', () => {
    expect(toolPreview('Edit', { file_path: '/p/a.py', old_string: 'x = 1', new_string: 'x = 2' })).toBe('✏️ `/p/a.py`\n```diff\n- x = 1\n+ x = 2\n```')
  })
  test('MCP tool: server, tool and input', () => {
    const out = toolPreview('mcp__github__create_issue', { title: 't' })
    expect(out.split('\n')[0]).toBe('🔌 github · create_issue')
    expect(out).toContain('"title": "t"')
  })
  test('backticks in content cannot close the fence', () => {
    expect(toolPreview('Bash', { command: 'echo ```' })).toBe('```bash\necho ˋˋˋ\n```')
  })
})

describe('cardEmbed', () => {
  test('colour by state, plain title, status appended', () => {
    const e = cardEmbed({ title: '🔐 **Permission needed: Bash**', body: 'body', footer: '-# reply `yes abcde`' }, 'approved', '-# **✅ Allowed** (me)').toJSON()
    expect(e.color).toBe(0x23a55a)
    expect(e.title).toBe('🔐 Permission needed: Bash')
    expect(e.description).toBe('body\n\n**✅ Allowed** (me)')
    expect(e.footer).toBeUndefined()
    expect(cardEmbed({ title: 't', body: 'b', footer: '-# reply `yes abcde`' }, 'pending').toJSON().footer?.text).toBe('reply yes abcde')
  })
  test('a long body is cut to fit, keeping the status', () => {
    const body = '```\n' + 'x\n'.repeat(5000) + '```'
    const e = cardEmbed({ title: 't', body }, 'closed', 'STATUS').toJSON()
    expect(e.description!.length).toBeLessThanOrEqual(4096)
    expect(e.description!.endsWith('STATUS')).toBe(true)
    expect((e.description!.match(/```/g) ?? []).length % 2).toBe(0)
  })
})

describe('renderRecord', () => {
  test('an interruption is a note, not local input', () => {
    const { renderRecord } = require('../src/render')
    const blocks = renderRecord(
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { toolNames: new Map(), showToolCalls: true },
    )
    expect(blocks).toEqual([{ kind: 'info', text: '-# ⏹️ Interrupted' }])
  })
})
