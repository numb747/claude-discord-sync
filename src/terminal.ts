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
 * Claude Code's input line: "❯", a no-break space, what has been typed, then
 * the cursor it draws in inverse video. Lines of earlier prompts in the
 * scrollback have the "❯" but no cursor.
 */
const PROMPT_RE = /❯[\u00a0 ](.*?)\x1b\[7m/

/**
 * The input line on a screen captured with colours: `draft` is the text before
 * the cursor. Undefined when no input line is showing: a dialog, a picker such
 * as /model's, or `!` shell mode.
 */
export function promptOf(screenWithColors: string): { draft: string } | undefined {
  const line = screenWithColors
    .split('\n')
    .reverse()
    .find(l => PROMPT_RE.test(l))
  if (!line) return undefined
  return { draft: stripAnsi(PROMPT_RE.exec(line)![1]).trim() }
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
