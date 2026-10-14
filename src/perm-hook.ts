#!/usr/bin/env bun
/**
 * PermissionRequest hook (installed by `ccd`): relays permission prompts,
 * AskUserQuestion and ExitPlanMode to Discord without Claude Code's channels.
 *
 * Claude Code shows its own dialog in the terminal while this hook runs, so
 * either side can answer: a decision printed here closes the terminal dialog,
 * and an answer in the terminal leaves this hook's output unused (the daemon
 * notices the session moving on and closes our socket, which ends the hook).
 *   tool permission -> allow / allow always (the prompt's suggestions) / deny
 *   AskUserQuestion -> allow with the answers in `updatedInput.answers`
 *   ExitPlanMode    -> sent back: deny with the feedback. Approving is a key
 *                      press in the terminal dialog, done by the daemon, because
 *                      Claude Code ignores a hook's "allow" for plans.
 * Any failure prints nothing and exits 0: the terminal dialog stays as it was.
 */
import { connect } from 'net'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs'
import { SOCKET_PATH } from './config'
import { send, onLines, type ClientMsg, type DaemonMsg, type PermDecision } from './ipc'

type HookInput = {
  session_id?: string
  transcript_path?: string
  tool_name?: string
  tool_input?: Record<string, any>
  permission_suggestions?: unknown[]
}

/** How much of the transcript's end to search for the plan file. */
const TAIL_BYTES = 2 * 1024 * 1024

/** The last plan file (~/.claude/plans/*.md) Claude wrote or edited, from the transcript's tail. */
function lastPlanFile(transcript: string | undefined): string | undefined {
  if (!transcript) return undefined
  let fd: number | undefined
  try {
    fd = openSync(transcript, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('/plans/')) continue
      try {
        for (const item of JSON.parse(line)?.message?.content ?? []) {
          const file = item?.type === 'tool_use' ? item.input?.file_path : undefined
          if (typeof file === 'string' && /[\\/]plans[\\/][^\\/]+\.md$/.test(file)) return file
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

/**
 * The plan being approved: ExitPlanMode's `plan`, or (when Claude wrote the plan
 * to its plan file first and called ExitPlanMode with no input) that file.
 */
function planOf(input: HookInput): string {
  const ti = input.tool_input ?? {}
  if (typeof ti.plan === 'string' && ti.plan.trim()) return ti.plan
  const file = typeof ti.planFilePath === 'string' ? ti.planFilePath : lastPlanFile(input.transcript_path)
  try {
    if (file) return readFileSync(file, 'utf8')
  } catch {}
  return '(The plan is shown in the terminal; use /screen to read it.)'
}
type Reply = Extract<DaemonMsg, { t: 'ask_result' | 'plan_result' | 'perm_result' }>

function askDaemon(msg: ClientMsg): Promise<Reply | undefined> {
  return new Promise(resolve => {
    const sock = connect(SOCKET_PATH)
    const done = (reply?: Reply) => {
      sock.destroy()
      resolve(reply)
    }
    sock.on('connect', () => send(sock, msg))
    onLines<DaemonMsg>(sock, m => {
      if (m.t === 'ask_result' || m.t === 'plan_result' || m.t === 'perm_result') done(m)
    })
    sock.on('error', () => done())
    sock.on('close', () => done())
  })
}

function decide(decision: PermDecision) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
}

try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  const sessionId = input.session_id
  const tool = input.tool_name
  const ti = input.tool_input ?? {}
  if (sessionId && tool === 'AskUserQuestion' && Array.isArray(ti.questions)) {
    const r = await askDaemon({ t: 'ask', sessionId, questions: ti.questions, race: true })
    if (r?.t === 'ask_result' && r.answers) decide({ behavior: 'allow', updatedInput: { ...ti, answers: r.answers } })
  } else if (sessionId && tool === 'ExitPlanMode') {
    const r = await askDaemon({ t: 'plan', sessionId, plan: planOf(input), race: true })
    if (r?.t === 'plan_result' && !r.approved) {
      decide({
        behavior: 'deny',
        message: `The user asked on Discord to revise the plan. Revise it accordingly and present it again:\n${r.feedback ?? ''}`,
      })
    }
  } else if (sessionId && tool) {
    const r = await askDaemon({ t: 'perm', sessionId, toolName: tool, toolInput: ti, suggestions: input.permission_suggestions })
    if (r?.t === 'perm_result' && r.decision) decide(r.decision)
  }
} catch {}
process.exit(0)
