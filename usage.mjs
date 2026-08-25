#!/usr/bin/env node
// Live AI provider quota for Herdr. Zero deps, Node 18+ (global fetch).
// Mechanisms mirror stablyai/orca's rate-limit fetchers:
//   Claude  -> GET api.anthropic.com/api/oauth/usage  (token: Keychain or ~/.claude/.credentials.json)
//   Codex   -> `codex app-server` JSON-RPC account/rateLimits/read
//   OpenCode-> opencode.ai cookie -> /_server workspace list -> scrape /workspace/<id>/go
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERDR = process.env.HERDR_BIN_PATH ?? 'herdr'
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? 'herdr-usage'
const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR ?? dirname(fileURLToPath(import.meta.url))

// ---------- shared helpers ----------
const now = () => Date.now()

function fmtReset(ms) {
  if (ms == null) return '—'
  let d = Math.round((ms - now()) / 1000)
  if (d <= 0) return 'now'
  const day = Math.floor(d / 86400); d -= day * 86400
  const h = Math.floor(d / 3600); d -= h * 3600
  const m = Math.floor(d / 60)
  if (day) return `in ${day}d ${h}h`
  if (h) return `in ${h}h ${m}m`
  return `in ${m}m`
}

function bar(pct, width = 20) {
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const n = Math.round((p / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

const ANSI = /\x1b\[[0-9;]*m/g
const vlen = (s) => s.replace(ANSI, '').length
function truncV(s, n) {
  if (vlen(s) <= n) return s
  let out = '', seen = 0, i = 0
  while (i < s.length && seen < n - 1) {
    if (s[i] === '\x1b') { const e = s.indexOf('m', i); out += s.slice(i, e + 1); i = e + 1; continue }
    out += s[i]; i++; seen++
  }
  return out + '…\x1b[0m'
}

function win(label, usedPercent, resetsAt) {
  return { label, usedPercent, resetsAt }
}
function codexLabel(mins, fallback) {
  if (!mins) return fallback
  if (mins <= 360) return `${Math.round(mins / 60)}h`
  if (mins <= 10080) return 'Week'
  return 'Month'
}

function readEnvFile() {
  const out = {}
  try {
    const txt = readFileSync(join(CONFIG_DIR, '.env'), 'utf8')
    for (const line of txt.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* no config */ }
  return out
}

// ---------- Claude ----------
function claudeToken() {
  // macOS Keychain first (Claude Code stores creds there), then legacy file.
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const t = JSON.parse(raw)?.claudeAiOauth?.accessToken
      if (t) return t
    } catch { /* fall through */ }
  }
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null
  } catch { return null }
}

async function fetchClaude() {
  const token = claudeToken()
  if (!token) return { provider: 'Claude', error: 'not logged in (no Claude Code credentials)' }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000)
    })
    if (res.status === 401) return { provider: 'Claude', error: 'token expired — run `claude` to refresh' }
    if (!res.ok) return { provider: 'Claude', error: `HTTP ${res.status}` }
    const d = await res.json()
    const mk = (w) => {
      if (!w || typeof w.utilization !== 'number') return null
      const ts = typeof w.resets_at === 'number'
        ? (w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at)
        : Date.parse(w.resets_at)
      return { pct: w.utilization, resetsAt: Number.isFinite(ts) ? ts : null }
    }
    const s = mk(d.five_hour), wk = mk(d.seven_day), fb = mk(d.fable_weekly ?? d.fable_seven_day ?? d.seven_day_fable)
    const wins = []
    if (s) wins.push(win('5h', s.pct, s.resetsAt))
    if (wk) wins.push(win('Week', wk.pct, wk.resetsAt))
    if (fb) wins.push(win('Fable', fb.pct, fb.resetsAt))
    if (!wins.length) return { provider: 'Claude', error: 'no usage windows in response' }
    return { provider: 'Claude', windows: wins }
  } catch (e) {
    return { provider: 'Claude', error: e.message }
  }
}

// ---------- Codex (app-server JSON-RPC) ----------
function fetchCodex() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('codex', ['-s', 'read-only', '-a', 'never', 'app-server'], {
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      return resolve({ provider: 'Codex', error: 'codex not found on PATH' })
    }
    let buf = '', done = false, id = 0, initId = 0, rlId = 0
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill() } catch {} resolve(r) }
    const send = (method, params) => { id += 1; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'); return id }
    const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: {} }) + '\n')
    const timer = setTimeout(() => finish({ provider: 'Codex', error: 'timeout (is codex logged in?)' }), 10000)

    child.on('error', (e) => finish({ provider: 'Codex', error: e.code === 'ENOENT' ? 'codex not found on PATH' : e.message }))
    child.on('close', () => finish({ provider: 'Codex', error: 'app-server exited (run `codex login`?)' }))
    child.stdout.on('data', (c) => {
      buf += c.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        if (msg.id == null) continue
        if (msg.id === initId) { notify('initialized'); rlId = send('account/rateLimits/read'); continue }
        if (msg.id === rlId) {
          if (msg.error) return finish({ provider: 'Codex', error: msg.error.message })
          const rl = msg.result?.rateLimits ?? {}
          const mk = (w) => (w && typeof w.usedPercent === 'number')
            ? { pct: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null, mins: w.windowDurationMins } : null
          const s = mk(rl.primary), wk = mk(rl.secondary), wins = []
          if (s) wins.push(win(codexLabel(s.mins, '5h'), s.pct, s.resetsAt))
          if (wk) wins.push(win(codexLabel(wk.mins, 'Week'), wk.pct, wk.resetsAt))
          if (!wins.length) return finish({ provider: 'Codex', error: 'no rate-limit windows' })
          return finish({ provider: 'Codex', windows: wins })
        }
      }
    })
    initId = send('initialize', { clientInfo: { name: 'herdr-ai-usage', version: '0.1.0' } })
  })
}

// ---------- OpenCode (opencode.ai) ----------
// ponytail: scrapes React-Flight HTML from opencode.ai; hash + parser are fragile,
// upgrade to a real API if opencode.ai ships one.
const OC_BASE = 'https://opencode.ai'
const OC_WORKSPACES_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

function extractUsageBlock(text, key) {
  const re = new RegExp(`\\b${key}\\b\\s*:`, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length
    const off = text.slice(start, start + 30).indexOf('{')
    if (off === -1) continue
    const open = start + off
    let depth = 0, block = null
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) { block = text.slice(open, i + 1); break }
    }
    if (block && topNum(block, 'usagePercent') !== null && topNum(block, 'resetInSec') !== null) return block
  }
  return null
}

function topNum(obj, field) {
  const re = new RegExp(`\\b${field}\\b\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`)
  let depth = 0
  for (let i = 0; i < obj.length; i++) {
    const ch = obj[i]
    if (ch === '{') { depth++; continue }
    if (ch === '}') { depth--; continue }
    if (depth === 1) {
      const mm = re.exec(obj.slice(i, i + field.length + 30))
      if (mm && mm.index === 0) { const n = parseFloat(mm[1]); return Number.isFinite(n) ? n : null }
    }
  }
  return null
}

function parseSubscription(text) {
  if (!text || text.length > 10_000_000) return null
  const clamp = (n) => Math.min(100, Math.max(0, n))
  const rb = extractUsageBlock(text, 'rollingUsage')
  const wb = extractUsageBlock(text, 'weeklyUsage')
  const mb = extractUsageBlock(text, 'monthlyUsage')
  const rp = rb && topNum(rb, 'usagePercent'), rr = rb && topNum(rb, 'resetInSec')
  const wp = wb && topNum(wb, 'usagePercent'), wr = wb && topNum(wb, 'resetInSec')
  if (rp == null || rr == null || wp == null || wr == null) return null
  const mp = mb && topNum(mb, 'usagePercent'), mr = mb && topNum(mb, 'resetInSec')
  return {
    rolling: [clamp(rp), rr], weekly: [clamp(wp), wr],
    monthly: mp != null && mr != null ? [clamp(mp), mr] : null
  }
}

function normalizeCookie(raw) {
  const t = raw.trim()
  if (!t) return ''
  if (t.includes(';') || /^(?:auth|__Host-auth)=/i.test(t)) return t
  if (t.startsWith('Fe26.2**') || /^[a-zA-Z0-9.\-_]+$/.test(t)) return `auth=${t}`
  return t
}

function authCookieOnly(raw) {
  return raw.split(';').map((p) => p.trim())
    .filter((p) => { const e = p.indexOf('='); return e > 0 && ['auth', '__Host-auth'].includes(p.slice(0, e).trim()) })
    .join('; ')
}

async function fetchOpenCode() {
  const env = readEnvFile()
  const rawCookie = env.OPENCODE_COOKIE || process.env.OPENCODE_COOKIE
  if (!rawCookie) return { provider: 'OpenCode', error: 'not configured — set OPENCODE_COOKIE in config .env (see README)' }
  const cookie = authCookieOnly(normalizeCookie(rawCookie))
  if (!cookie) return { provider: 'OpenCode', error: 'no auth cookie — paste the opencode.ai Cookie header' }
  try {
    let ids = []
    const override = (env.OPENCODE_WORKSPACE_ID || '').trim()
    if (override) ids = [override]
    else {
      const r = await fetch(`${OC_BASE}/_server?id=${OC_WORKSPACES_ID}`, {
        headers: {
          Cookie: cookie, 'X-Server-Id': OC_WORKSPACES_ID,
          'X-Server-Instance': `server-fn:${crypto.randomUUID()}`,
          Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8', Origin: OC_BASE, Referer: OC_BASE
        },
        signal: AbortSignal.timeout(15000)
      })
      if (!r.ok) return { provider: 'OpenCode', error: `workspaces fetch ${r.status} (cookie expired?)` }
      const txt = await r.text()
      for (const mm of txt.matchAll(/\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g)) if (!ids.includes(mm[1])) ids.push(mm[1])
    }
    if (!ids.length) return { provider: 'OpenCode', error: 'no workspace found' }
    let last = ''
    for (const id of ids) {
      const pr = await fetch(`${OC_BASE}/workspace/${id}/go`, {
        headers: { Cookie: cookie, Accept: 'text/html,*/*;q=0.8', Origin: OC_BASE, Referer: OC_BASE },
        signal: AbortSignal.timeout(15000)
      })
      if (!pr.ok) { last = `page ${pr.status}`; continue }
      const parsed = parseSubscription(await pr.text())
      if (parsed) {
        const wins = [
          win('5h', parsed.rolling[0], now() + parsed.rolling[1] * 1000),
          win('Week', parsed.weekly[0], now() + parsed.weekly[1] * 1000)
        ]
        if (parsed.monthly) wins.push(win('Month', parsed.monthly[0], now() + parsed.monthly[1] * 1000))
        return { provider: 'OpenCode', windows: wins }
      }
      last = 'could not parse usage'
    }
    return { provider: 'OpenCode', error: last || 'no usage data' }
  } catch (e) {
    return { provider: 'OpenCode', error: e.message }
  }
}

// ---------- render ----------
const BAR_W = 24
function render(results) {
  const PAD = '  '
  const inner = Math.min((process.stdout.columns || 80) - 2, 74) - 4
  const dim = (s) => `\x1b[2m${s}\x1b[0m`
  const rule = `\x1b[38;5;237m${'─'.repeat(inner)}\x1b[0m`
  const body = []
  results.forEach((r, i) => {
    if (i > 0) body.push('')
    body.push(`\x1b[38;5;44m●\x1b[0m \x1b[1m${r.provider}\x1b[0m${r.stale ? dim(`  cached ${fmtAgo(r.stale)} ago`) : ''}`)
    if (r.error) body.push(`   \x1b[38;5;214m!\x1b[0m ${dim(r.error)}`)
    else for (const w of r.windows) {
      const u = Math.max(0, Math.min(100, w.usedPercent ?? 0))
      const col = u >= 90 ? '\x1b[38;5;203m' : u >= 70 ? '\x1b[38;5;214m' : '\x1b[38;5;42m'
      const n = Math.round(u / 100 * BAR_W)
      const barStr = `${col}${'█'.repeat(n)}\x1b[38;5;240m${'░'.repeat(BAR_W - n)}\x1b[0m`
      const pct = `${u.toFixed(0)}%`.padStart(4)
      body.push(`   ${w.label.padEnd(6)}${barStr} \x1b[1m${col}${pct}\x1b[0m  ${dim('resets ' + fmtReset(w.resetsAt))}`)
    }
    const extras = []
    if (r.today) extras.push(`↑${fmtTok(r.today.in)} ↓${fmtTok(r.today.out)}${r.today.cost ? ` $${r.today.cost.toFixed(2)}` : ''}`)
    if (r.spark && r.provider !== 'Codex') extras.push(`trend ${r.spark} ${r.peak}%`)
    if (extras.length) { body.push(''); body.push(`   ${dim(extras.join('   '))}`) }
  })

  // Single border = Herdr's pane frame; just lay out content inside it.
  const hint = `\x1b[2m[q] quit  ·  ↻ 30s\x1b[0m`
  const lines = [...body.map((l) => truncV(l, inner)), '', rule, hint]
  return ['', '', ...lines.map((l) => (l ? PAD + l : l))].join('\n')
}

async function collect() {
  return Promise.all([fetchClaude(), fetchCodex(), fetchOpenCode()])
}

// ---------- history / trend ----------
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? CONFIG_DIR
const HIST = join(STATE_DIR, 'history.json')
const SPARK = '▁▂▃▄▅▆▇█'
const LASTGOOD = join(STATE_DIR, 'lastgood.json')
const primaryPct = (r) => { const w = r.windows?.[0]; return w ? Math.round(w.usedPercent ?? 0) : null }
function fmtAgo(ms) { const d = Math.round((Date.now() - ms) / 1000); return d < 60 ? `${d}s` : d < 3600 ? `${Math.floor(d / 60)}m` : `${Math.floor(d / 3600)}h` }
// Rate-limit resilience: keep the last good windows; on error, show them stale instead of the error.
function applyCache(results) {
  let store = {}
  try { store = JSON.parse(readFileSync(LASTGOOD, 'utf8')) } catch { /* first run */ }
  for (const r of results) {
    if (r.windows?.length) store[r.provider] = { windows: r.windows, at: Date.now() }
    else if (store[r.provider]) { r.windows = store[r.provider].windows; r.stale = store[r.provider].at; delete r.error }
  }
  try { writeFileSync(LASTGOOD, JSON.stringify(store)) } catch { /* read-only fs */ }
}
function spark(nums) {
  return nums.map((n) => SPARK[Math.min(7, Math.floor((Math.max(0, Math.min(100, n)) / 100) * 8))]).join('')
}
function recordHistory(results) {
  let h = []
  try { h = JSON.parse(readFileSync(HIST, 'utf8')) } catch { /* first run */ }
  const v = {}
  for (const r of results) { const p = primaryPct(r); if (p != null) v[r.provider] = p }
  if (Object.keys(v).length) h.push({ t: Date.now(), v })
  h = h.slice(-60)
  try { writeFileSync(HIST, JSON.stringify(h)) } catch { /* read-only fs */ }
  return h
}
function attachTrend(results, hist) {
  for (const r of results) {
    const vals = hist.map((h) => h.v[r.provider]).filter((x) => typeof x === 'number').slice(-24)
    r.spark = vals.length >= 2 ? spark(vals) : ''
    r.peak = vals.length ? Math.max(...vals) : null
  }
}

// ---------- consumption today (local logs) ----------
function todayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
function fmtTok(n) { n = n || 0; return n < 1000 ? String(n) : n < 1e6 ? (n / 1e3).toFixed(1) + 'k' : (n / 1e6).toFixed(2) + 'M' }

function claudeToday() {
  // in = fresh input + cache writes (billable); cache_read excluded (cheap re-reads that dwarf the rest).
  const start = todayStart(), dir = join(homedir(), '.claude', 'projects')
  let inp = 0, out = 0
  try {
    for (const proj of readdirSync(dir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue
      const pdir = join(dir, proj.name)
      for (const fn of readdirSync(pdir)) {
        if (!fn.endsWith('.jsonl')) continue
        const fp = join(pdir, fn)
        try { if (statSync(fp).mtimeMs < start) continue } catch { continue }
        for (const line of readFileSync(fp, 'utf8').split('\n')) {
          if (!line) continue
          let o; try { o = JSON.parse(line) } catch { continue }
          const u = o.message?.usage
          if (!u || Date.parse(o.timestamp) < start) continue
          inp += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          out += (u.output_tokens || 0)
        }
      }
    }
  } catch { return null }
  return { in: inp, out }
}

function codexToday() {
  // ponytail: sums each session's cumulative total; a session spanning midnight over-counts slightly.
  const start = todayStart(), base = join(homedir(), '.codex', 'sessions')
  const days = [new Date(), new Date(Date.now() - 86400000)].map((d) =>
    [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')])
  let inSum = 0, outSum = 0, found = false
  for (const [y, m, d] of days) {
    let files; try { files = readdirSync(join(base, y, m, d)) } catch { continue }
    for (const fn of files) {
      if (!fn.endsWith('.jsonl')) continue
      let mIn = 0, mOut = 0, hit = false
      try {
        for (const line of readFileSync(join(base, y, m, d, fn), 'utf8').split('\n')) {
          if (!line.includes('token_count')) continue
          let o; try { o = JSON.parse(line) } catch { continue }
          const t = o.payload?.info?.total_token_usage
          if (!t || Date.parse(o.timestamp) < start) continue
          const ci = (t.input_tokens || 0), co = (t.output_tokens || 0) + (t.reasoning_output_tokens || 0)
          if (ci + co > mIn + mOut) { mIn = ci; mOut = co; hit = true }
        }
      } catch { continue }
      if (hit) { inSum += mIn; outSum += mOut; found = true }
    }
  }
  return found ? { in: inSum, out: outSum } : null
}

function opencodeDbPath() {
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  const p = join(base, 'opencode', 'opencode.db')
  try { statSync(p); return p } catch { return null }
}
async function opencodeToday() {
  const dbPath = opencodeDbPath(); if (!dbPath) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare("SELECT COALESCE(SUM(json_extract(data,'$.tokens.input')),0) inp, COALESCE(SUM(json_extract(data,'$.tokens.output')),0) outp, COALESCE(SUM(json_extract(data,'$.tokens.reasoning')),0) reas, COALESCE(SUM(json_extract(data,'$.cost')),0) cost FROM message WHERE time_created >= ? AND json_extract(data,'$.role')='assistant'").get(todayStart())
    db.close()
    return { in: Number(row.inp) || 0, out: (Number(row.outp) || 0) + (Number(row.reas) || 0), cost: Number(row.cost) || 0 }
  } catch { return null }
}

async function consumeToday() {
  const [c, x, o] = await Promise.all([Promise.resolve(claudeToday()), Promise.resolve(codexToday()), opencodeToday()])
  return { Claude: c, Codex: x, OpenCode: o }
}
function attachConsumption(results, cons) {
  for (const r of results) r.today = cons?.[r.provider] ?? null
}

// ---------- animation ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function scale(results, t) {
  return results.map((r) => r.windows
    ? { ...r, windows: r.windows.map((w) => ({ ...w, usedPercent: (w.usedPercent ?? 0) * t })) }
    : r)
}
async function withSpinner(promise) {
  const f = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0, done = false
  const tick = () => { if (!done) process.stdout.write(`\x1b[2J\x1b[H\n  \x1b[36m${f[i++ % f.length]}\x1b[0m \x1b[2mfetching usage…\x1b[0m`) }
  tick(); const iv = setInterval(tick, 80)
  try { return await promise } finally { done = true; clearInterval(iv) }
}
async function animateIn(results) {
  const frames = 10
  for (let i = 1; i <= frames; i++) {
    const e = 1 - Math.pow(1 - i / frames, 3) // easeOutCubic
    process.stdout.write('\x1b[2J\x1b[H' + render(scale(results, e)))
    await sleep(24)
  }
}

async function paneLoop() {
  const tty = process.stdout.isTTY && process.stdin.isTTY
  if (tty) process.stdout.write('\x1b[?25l') // hide cursor
  let first = true, cons = null
  for (;;) {
    // Consumption reads local logs (incl. a 400MB SQLite scan) — compute once per open, reuse on refresh.
    const work = Promise.all([collect(), first ? consumeToday() : Promise.resolve(cons)])
    const [results, c] = (first && tty) ? await withSpinner(work) : await work
    cons = c
    applyCache(results)
    attachConsumption(results, cons)
    attachTrend(results, recordHistory(results))
    if (first && tty) await animateIn(results)
    else process.stdout.write('\x1b[2J\x1b[H' + render(results))
    first = false
    if (!tty) return
    process.stdin.setRawMode(true); process.stdin.resume()
    // Wait for a key OR 30s, then re-render. Any key refreshes; q/esc/ctrl-c quits.
    const key = await new Promise((res) => {
      const t = setTimeout(() => { process.stdin.off('data', on); res('') }, 30000)
      function on(d) { clearTimeout(t); process.stdin.off('data', on); res(d.toString()) }
      process.stdin.on('data', on)
    })
    process.stdin.setRawMode(false); process.stdin.pause()
    if (key === 'q' || key === '\x1b' || key === '\x03') return
  }
}

async function main() {
  // Invoked as the `show` action -> open the popup pane (action stdout isn't visible).
  if (process.env.HERDR_PLUGIN_ACTION_ID) {
    spawn(HERDR, ['plugin', 'pane', 'open', '--plugin', PLUGIN_ID, '--entrypoint', 'panel'], { stdio: 'ignore', detached: true }).unref()
    return
  }
  if (process.argv.includes('--selftest')) return selftest()
  process.on('exit', () => process.stdout.isTTY && process.stdout.write('\x1b[?25h')) // restore cursor
  await paneLoop()
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } }
  assert(bar(0) === '░'.repeat(20), 'bar 0')
  assert(bar(100) === '█'.repeat(20), 'bar 100')
  assert(fmtReset(now() + 3_600_000).startsWith('in 1h'), 'reset 1h')
  assert(fmtReset(now() - 1000) === 'now', 'reset past')
  const sample = `x rollingUsage:$R[2]={usagePercent:42.5,resetInSec:3600,detail:{usagePercent:9}} weeklyUsage:{usagePercent:10,resetInSec:600} monthlyUsage:null`
  const p = parseSubscription(sample)
  assert(p && p.rolling[0] === 42.5 && p.rolling[1] === 3600, 'scrape rolling')
  assert(p.weekly[0] === 10 && p.monthly === null, 'scrape weekly/monthly')
  assert(authCookieOnly(normalizeCookie('Fe26.2**abc')) === 'auth=Fe26.2**abc', 'cookie normalize')
  assert(scale([{ provider: 'C', windows: [{ label: '5h', usedPercent: 80 }] }], 0.5)[0].windows[0].usedPercent === 40, 'scale')
  assert(spark([0, 100]) === '▁█' && spark([50]) === '▅', 'spark')
  assert(codexLabel(300) === '5h' && codexLabel(10080) === 'Week' && codexLabel(43200) === 'Month', 'codexLabel')
  assert(fmtTok(500) === '500' && fmtTok(1500) === '1.5k' && fmtTok(2500000) === '2.50M', 'fmtTok')
  console.log('ok')
}

main()
