/**
 * Claude Code's screen in a tmux pane, read and typed into. Without channels
 * this is how Discord reaches a session: messages are pasted at the prompt,
 * dialogs are answered by their option number, and `/key` presses keys.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'

export type Pane = { socket: string; pane: string }

const run = promisify(execFile)
export const tmux = (p: Pane, args: string[]) => run('tmux', ['-S', p.socket, ...args])

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
export const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

export async function capture(p: Pane, colors = false): Promise<string> {
  return (await tmux(p, ['capture-pane', '-p', ...(colors ? ['-e'] : []), '-t', p.pane])).stdout
}

/** Leave copy mode (the user scrolled back), where keys would move the view instead of reaching Claude Code. */
export async function leaveCopyMode(p: Pane): Promise<void> {
  const { stdout } = await tmux(p, ['display-message', '-p', '-t', p.pane, '#{pane_in_mode}'])
  if (stdout.trim() === '1') await tmux(p, ['send-keys', '-t', p.pane, '-X', 'cancel'])
}

/**
 * Tell the pane it has focus, as a terminal does with focus reporting on. Claude
 * Code stops showing its cursor when tmux reports the focus gone (someone was
 * attached to the session and left, or a split moved it), and never gets it back
 * while nobody is attached.
 */
export async function focusIn(p: Pane): Promise<void> {
  await tmux(p, ['send-keys', '-t', p.pane, '-H', '1b', '5b', '49'])
}

export type Cursor = { x: number; y: number }

/**
 * The screen with colours and the terminal's cursor (undefined while hidden),
 * read by one tmux command so the two match.
 */
export async function captureWithCursor(p: Pane): Promise<{ screen: string; cursor?: Cursor }> {
  const { stdout } = await tmux(p, ['display-message', '-p', '-t', p.pane, '#{cursor_flag} #{cursor_x} #{cursor_y}', ';', 'capture-pane', '-p', '-e', '-t', p.pane])
  const nl = stdout.indexOf('\n')
  const [flag, x, y] = stdout.slice(0, nl).split(' ').map(Number)
  return { screen: stdout.slice(nl + 1), cursor: flag ? { x, y } : undefined }
}

/** The input box showing in the pane right now; see promptOf. */
export async function promptIn(p: Pane): Promise<{ draft: string } | undefined> {
  const { screen, cursor } = await captureWithCursor(p)
  return promptOf(screen, cursor)
}

/**
 * Claude Code's input box: a rule, "❯" and a no-break space, what has been typed
 * (continuation lines indented by two), the cursor, then another rule. Up to
 * 2.1.273 Claude Code drew the cursor itself in inverse video; later versions
 * use the terminal's cursor instead, and show a dimmed hint ("Try …") in an
 * empty box. Earlier prompts in the scrollback have the "❯" but neither the rule
 * above nor a cursor; dialogs mark their selected option with an indented "❯".
 * What has been typed is never dimmed; hints and suggestions always are.
 */
/** The rules above and below it; either can carry a label, so only the start is checked. */
const BOX_EDGE_RE = /^─/
const PROMPT_START_RE = /^❯[\u00a0 ]/
const CURSOR = '\x1b[7m'

/**
 * The input box on a screen captured with colours: `draft` is everything typed
 * in it, every line, wherever the cursor is in it. `cursor` is the terminal's
 * cursor, for versions that don't draw their own. Undefined when no input box
 * is showing: a dialog, a picker such as /model's, or `!` shell mode.
 */
export function promptOf(screenWithColors: string, cursor?: Cursor): { draft: string } | undefined {
  const lines = screenWithColors.split('\n')
  const plain = lines.map(stripAnsi)
  let start = -1
  for (let i = plain.length - 1; i > 0 && start < 0; i--) if (PROMPT_START_RE.test(plain[i]) && BOX_EDGE_RE.test(plain[i - 1])) start = i
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && !BOX_EDGE_RE.test(plain[end])) end++
  const box = lines.slice(start, end).join('\n')
  // A box without the cursor in it isn't taking input.
  if (!box.includes(CURSOR) && !(cursor && cursor.y >= start && cursor.y < end)) return undefined
  // The cursor can be anywhere in what was typed (Home, ←), so all of the box counts.
  const draft = undimmed(box).replace(PROMPT_START_RE, '').replace(/\n {2}/g, '\n')
  return { draft: draft.trim() }
}

/** A long paste, collapsed in the box ("[Pasted text #2 +13 lines]"); the transcript has it in full. */
const PASTED_RE = /\[Pasted text #\d+(?: \+(\d+) lines?)?\]/g

/**
 * Whether the box's `draft` is the message `sent` put back: the same text give
 * or take whitespace (the box wraps it), each collapsed paste standing for as
 * many lines of `sent` as it says.
 */
export function draftIsMessage(draft: string, sent: string): boolean {
  const literal = (s: string) => [...s.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/, '\\$&')).join('\\s*')
  let re = ''
  let at = 0
  for (const p of draft.matchAll(PASTED_RE)) {
    re += `${literal(draft.slice(at, p.index))}\\s*${p[1] ? `(?:[^\\n]*\\n){${p[1]}}[^\\n]*` : '[\\s\\S]+?'}\\s*`
    at = p.index + p[0].length
  }
  re += literal(draft.slice(at))
  return new RegExp(`^\\s*${re}\\s*$`).test(sent)
}

/** The live input box's "❯ …" line (the one drawn under a rule), or undefined when no box is drawn. */
function boxLine(screen: string): string | undefined {
  const plain = stripAnsi(screen).split('\n')
  for (let i = plain.length - 1; i > 0; i--) if (PROMPT_START_RE.test(plain[i]) && BOX_EDGE_RE.test(plain[i - 1])) return plain[i]
  return undefined
}

/**
 * A live input box is drawn (its top rule and "❯"), whether or not it holds the
 * cursor. Lost focus draws the box but hides the cursor, so promptIn reads it as
 * no input line though it is one; a dialog or menu draws no box at all.
 */
export function hasPromptBox(screen: string): boolean {
  return boxLine(screen) !== undefined
}

const ANSI_SPLIT_RE = new RegExp(`(${ANSI_RE.source})`)

/** Text captured with colours, without the colours and without what was shown dimmed. */
function undimmed(text: string): string {
  let dim = false
  let out = ''
  for (const part of text.split(ANSI_SPLIT_RE)) {
    if (part.startsWith('\x1b[')) {
      if (part.endsWith('m')) dim = dimAfter(part, dim)
    } else out += dim ? part.replace(/[^\n]/g, '') : part
  }
  return out
}

/** Whether text is dimmed after the SGR sequence `sgr`, given whether it was before. */
function dimAfter(sgr: string, dim: boolean): boolean {
  const ps = sgr.slice(2, -1).split(';')
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    if (p === '' || p === '0' || p === '22') dim = false
    else if (p === '2') dim = true
    // 38;5;n and 38;2;r;g;b: colour arguments, not attributes.
    else if (p === '38' || p === '48' || p === '58') i += ps[i + 1] === '5' ? 2 : 4
  }
  return dim
}

/**
 * The agent list under the input box while background agents or teammates run:
 * the main session first, then one row per agent. "●" marks the one on view,
 * "❯" the selection while the list has the keyboard (↓ from the box). With
 * another agent on view the box reads "Message @…" and talks to that agent.
 */
export type AgentList = { names: string[]; viewing: number; selected?: number }

const AGENT_ROW_RE = /^(❯| ) ([●◯]) (\S+)/
/** The box's placeholder while an agent is on view: a message typed now goes to that agent. */
const AGENT_BOX_RE = /^❯[  ]+Message @\S/
/** ← on an empty box with agents running asks this; Enter would background the session. */
const BACKGROUND_DIALOG_RE = /^\s*Background this session\?\s*$/

/**
 * The input box is addressed to a sub-agent ("Message @name…"), so a message
 * typed now would reach that agent instead of the main session. Read straight
 * from the box line, so it still holds when the agent list below is too long or
 * too far up the screen for agentList to parse.
 */
export function onAgentView(screen: string): boolean {
  const l = boxLine(screen)
  return l !== undefined && AGENT_BOX_RE.test(l)
}

/** The last non-blank lines of a screen, without colours. */
function tailLines(screen: string, n: number): string[] {
  const lines = stripAnsi(screen).split('\n')
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  return lines.slice(Math.max(0, end - n), end)
}

export function agentList(screen: string): AgentList | undefined {
  const lines = tailLines(screen, 60)
  let i = lines.length
  while (i > 0 && AGENT_ROW_RE.test(lines[i - 1])) i--
  const rows = lines.slice(i).map(l => AGENT_ROW_RE.exec(l)!)
  const viewing = rows.findIndex(r => r[2] === '●')
  if (!rows.length || viewing < 0) return undefined
  const selected = rows.findIndex(r => r[1] === '❯')
  return { names: rows.map(r => r[3]), viewing, ...(selected >= 0 ? { selected } : {}) }
}

/**
 * The key that takes the screen a step back to the main session's own input
 * box, or undefined when it's there (or the screen isn't one of these). Only
 * moves the list's selection, views the main session (Enter on the first row),
 * or cancels the background dialog: never Enter on an agent, never x (stop).
 */
export function keyBackToLeader(screen: string): 'Up' | 'Down' | 'Enter' | 'Escape' | undefined {
  const tail = tailLines(screen, 8)
  if (tail.some(l => BACKGROUND_DIALOG_RE.test(l)) && /Esc to cancel/.test(tail.at(-1) ?? '')) return 'Escape'
  const list = agentList(screen)
  if (!list) return undefined
  if (list.selected === undefined) return list.viewing === 0 ? undefined : 'Down'
  if (list.selected > 0) return 'Up'
  return list.viewing === 0 ? 'Up' : 'Enter'
}

/**
 * Take the pane back to the main session's input box, where someone looking at
 * an agent left it; false if it didn't get there. After each key, waits for the
 * list to change so a slow redraw doesn't get the key pressed twice (↑ once too
 * often would bring back an old prompt).
 */
export async function backToLeader(p: Pane): Promise<boolean> {
  const where = (s: string) => JSON.stringify([keyBackToLeader(s) === 'Escape', agentList(s)])
  for (let i = 0; i < 8; i++) {
    const screen = await capture(p)
    const key = keyBackToLeader(screen)
    // No step left to take: we're at the main box — unless the box is still
    // addressed to an agent ("Message @…"), which keyBackToLeader misses when the
    // list is too long or too far up to parse. Typing there would reach the agent,
    // so report that instead of guessing we're home.
    if (!key) return !onAgentView(screen)
    await tmux(p, ['send-keys', '-t', p.pane, key])
    const before = where(screen)
    for (let t = 0; t < 10 && where(await capture(p)) === before; t++) await Bun.sleep(150)
  }
  return false
}

let pastes = 0

/**
 * Paste `text` at the prompt as one bracketed paste, so its newlines stay part
 * of the message and a leading `!` or `/` is taken as typed, then press Enter.
 */
export async function pasteAndSubmit(p: Pane, text: string): Promise<void> {
  const name = `cds-${process.pid}-${++pastes}`
  const load = Bun.spawn(['tmux', '-S', p.socket, 'load-buffer', '-b', name, '-'], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
  load.stdin.write(text)
  await load.stdin.end()
  if ((await load.exited) !== 0) throw new Error((await new Response(load.stderr).text()).trim() || 'tmux load-buffer failed')
  await tmux(p, ['paste-buffer', '-p', '-r', '-d', '-b', name, '-t', p.pane])
  // Enter right behind a long paste can arrive while Claude Code is still taking it in.
  await Bun.sleep(Math.min(1500, 250 + text.length / 10))
  await tmux(p, ['send-keys', '-t', p.pane, 'Enter'])
}

export type DialogOption = { n: string; label: string }

/**
 * The numbered options of the dialog at the bottom of the screen ("❯ 1. Yes",
 * "  2. No"): only the block around the cursor line, so numbered lines further
 * up (a plan's steps) don't count. Empty when there is no such dialog.
 */
export function dialogOptions(screen: string): DialogOption[] {
  const lines = screen.split('\n')
  const opt = /^\s*(?:❯\s*)?(\d)\.\s+(.*\S)\s*$/
  let c = lines.length - 1
  while (c >= 0 && !/^\s*❯\s*\d\.\s/.test(lines[c])) c--
  if (c < 0) return []
  // An option's description wraps onto lines indented deeper than the options.
  const indent = lines[c].search(/\S/)
  const inBlock = (l: string) => opt.test(l) || (l.trim() !== '' && l.search(/\S/) > indent + 2)
  // A blank line or a rule can separate groups of options (AskUserQuestion's "Chat about this").
  const gap = (l: string | undefined) => l !== undefined && (l.trim() === '' || RULE_RE.test(l))
  const next = (i: number, step: number) => {
    let j = i + step
    while (gap(lines[j])) j += step
    return lines[j] !== undefined && inBlock(lines[j]) ? j : -1
  }
  let a = c
  for (let j = next(a, -1); j >= 0; j = next(a, -1)) a = j
  let b = c
  for (let j = next(b, 1); j >= 0; j = next(b, 1)) b = j
  const out = lines.slice(a, b + 1).flatMap(l => {
    const match = opt.exec(l)
    return match ? [{ n: match[1], label: match[2] }] : []
  })
  return out.every((o, i) => o.n === String(i + 1)) ? out : []
}

const RULE_RE = /^\s*[─━▔▁╌]+\s*$/

/** The bottom of the screen without blank lines and rules, for posting a dialog. */
export function screenTail(screen: string, lines = 30): string {
  return screen
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l.trim() && !RULE_RE.test(l))
    .slice(-lines)
    .join('\n')
}

const KEY_NAMES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  tab: 'Tab',
  stab: 'BTab',
  btab: 'BTab',
  'shift-tab': 'BTab',
  space: 'Space',
  bs: 'BSpace',
  backspace: 'BSpace',
  'c-c': 'C-c',
  'ctrl-c': 'C-c',
}

/**
 * `/key` input such as "down down enter" or "2": tmux send-keys argument lists,
 * one per key. Single letters and digits are typed as is. Undefined if any
 * word isn't a key we know, or there are more than 12.
 */
export function parseKeys(spec: string): string[][] | undefined {
  const words = spec.trim().split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 12) return undefined
  const out: string[][] = []
  for (const w of words) {
    const name = KEY_NAMES[w.toLowerCase()]
    if (name) out.push([name])
    else if (/^[0-9a-z]$/i.test(w)) out.push(['-l', w])
    else return undefined
  }
  return out
}
