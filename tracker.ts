import type { Message, Part, Session } from '@opencode-ai/sdk/v2'

type Span = { start: number; end?: number }
type PartTiming = { type: string; span?: Span; pending?: number; toolStart?: number }
type Sample = { at: number; tokens: number }
type Record = {
  sessionID: string; created?: number; completed?: number; assistant?: boolean
  agent?: string; model?: string; output: number; input: number; cache: number
  parts: Map<string, PartTiming>; samples: Sample[]; firstDelta?: number; lastDelta?: number
  observed: boolean; error: boolean
}
export type Stats = {
  output: number; input: number; cache: number; responses: number; measured: number
  duration: number; measuredTokens: number; ttftTotal: number; ttftCount: number
  live: number; streaming: number; avg?: number; ttft?: number
}

export function unionDuration(spans: Span[]) {
  const sorted = spans.filter((s) => s.end !== undefined && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end! })).sort((a, b) => a.start - b.start)
  let total = 0, end = -Infinity
  for (const s of sorted) { total += Math.max(0, s.end - Math.max(end, s.start)); end = Math.max(end, s.end) }
  return total
}

export class Tracker {
  sessions = new Map<string, Pick<Session, 'id' | 'parentID' | 'title'>>()
  records = new Map<string, Record>()
  statuses = new Map<string, string>()

  session(info: Pick<Session, 'id' | 'parentID' | 'title'>) {
    this.sessions.set(info.id, { id: info.id, parentID: info.parentID, title: info.title })
  }
  record(id: string, sessionID: string) {
    let r = this.records.get(id)
    if (!r) {
      r = { sessionID, output: 0, input: 0, cache: 0, parts: new Map(), samples: [], observed: false, error: false }
      this.records.set(id, r)
    }
    return r
  }
  message(info: Message) {
    const r = this.record(info.id, info.sessionID)
    r.assistant = info.role === 'assistant'
    r.created = info.time.created
    if (info.role !== 'assistant') { this.records.delete(info.id); return }
    r.completed = info.time.completed
    r.agent = info.agent
    r.model = `${info.providerID}/${info.modelID}`
    r.output = (info.tokens.output || 0) + (info.tokens.reasoning || 0)
    r.input = info.tokens.input || 0
    r.cache = info.tokens.cache.read || 0
    r.error = !!info.error
    if (r.completed || r.error) r.samples = []
  }
  part(part: Part, at?: number, history = false) {
    if (!['text', 'reasoning', 'tool'].includes(part.type)) return
    if (part.type === 'text' && (part.synthetic || part.ignored)) return
    const r = this.record(part.messageID, part.sessionID)
    const old = r.parts.get(part.id)
    const p: PartTiming = { ...old, type: part.type }
    if (part.type === 'text' || part.type === 'reasoning') {
      if (part.time) p.span = { start: part.time.start, end: part.time.end }
    }
    if (part.type === 'tool') {
      if (part.state.status === 'pending' && !history && at !== undefined) p.pending ??= at
      if (part.state.status !== 'pending') {
        p.toolStart = part.state.time.start
        if (p.pending !== undefined) p.span = { start: p.pending, end: p.toolStart }
        // A tool finishing must never erase another stream's live samples.
        if (!history && part.state.status === 'running') r.samples = []
      }
    }
    r.parts.set(part.id, p)
  }
  delta(sessionID: string, messageID: string, partID: string, field: string, delta: string, at: number) {
    if (field !== 'text' || !delta) return
    const r = this.record(messageID, sessionID)
    if (r.completed || r.error || r.assistant === false) return
    const p = r.parts.get(partID)
    if (p && !['text', 'reasoning'].includes(p.type)) return
    r.firstDelta ??= at
    r.lastDelta = at
    r.observed = true
    this.prune(r, at)
    // Fractional accumulation avoids inflating TPS when servers send tiny chunks.
    const tokens = Buffer.byteLength(delta, 'utf8') / 5
    const last = r.samples.at(-1)
    if (last && Math.floor(last.at / 100) === Math.floor(at / 100)) last.tokens += tokens
    else r.samples.push({ at, tokens })
  }
  status(sessionID: string, type: string) {
    this.statuses.set(sessionID, type)
    if (type === 'idle' || type === 'error' || type === 'retry') {
      for (const r of this.records.values()) if (r.sessionID === sessionID) r.samples = []
    }
  }
  removeMessage(id: string) { this.records.delete(id) }
  removeSession(id: string) {
    this.sessions.delete(id); this.statuses.delete(id)
    for (const [key, r] of this.records) if (r.sessionID === id) this.records.delete(key)
  }
  prune(r: Record, now: number) { r.samples = r.samples.filter((s) => now - s.at <= 5000) }
  root(id: string) {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const parent = this.sessions.get(id)?.parentID
      if (!parent) break
      id = parent
    }
    return id
  }
  tree(id: string) {
    const ids = new Set([id])
    let changed = true
    while (changed) {
      changed = false
      for (const s of this.sessions.values()) {
        if (s.parentID && ids.has(s.parentID) && !ids.has(s.id)) { ids.add(s.id); changed = true }
      }
    }
    return ids
  }
  stats(ids: Set<string>, now: number): Stats {
    const s: Stats = { output: 0, input: 0, cache: 0, responses: 0, measured: 0, duration: 0,
      measuredTokens: 0, ttftTotal: 0, ttftCount: 0, live: 0, streaming: 0 }
    const streaming = new Set<string>()
    for (const r of this.records.values()) {
      if (!ids.has(r.sessionID) || !r.assistant) continue
      this.prune(r, now)
      if (!r.completed && !r.error && !['idle', 'retry', 'error'].includes(this.statuses.get(r.sessionID) ?? '')) {
        const last = r.samples.at(-1)
        if (last && now - last.at <= 1500) {
          s.live += r.samples.reduce((sum, item) => sum + item.tokens, 0) / (Math.max(1000, now - r.samples[0].at) / 1000)
          streaming.add(r.sessionID)
        }
      }
      if (!r.completed) continue
      s.output += r.output; s.input += r.input; s.cache += r.cache; s.responses++
      const spans = [...r.parts.values()].flatMap((p) => p.span ? [p.span] : [])
      const first = spans.length ? Math.min(...spans.map((p) => p.start)) : r.firstDelta
      // Persisted text/reasoning spans and observed tool-input spans exclude tool runtime.
      const duration = unionDuration(spans)
      // Tool execution time is absent from these spans; text/reasoning timing
      // remains useful even when the same response also contains a tool part.
      if (!r.error && r.output > 0 && duration >= 20) {
        s.duration += duration; s.measuredTokens += r.output; s.measured++
      }
      if (!r.error && first !== undefined && r.created !== undefined && first >= r.created) {
        s.ttftTotal += first - r.created; s.ttftCount++
      }
    }
    s.streaming = streaming.size
    if (s.duration > 0) s.avg = s.measuredTokens / (s.duration / 1000)
    if (s.ttftCount) s.ttft = s.ttftTotal / s.ttftCount / 1000
    return s
  }
}

export const rate = (n?: number) => n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(1)
export const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
export function line(s: Stats) {
  return `TPS ${s.streaming ? '~' + rate(s.live) : '—'} | AVG ${rate(s.avg)} | TTFT ${s.ttft === undefined ? '—' : rate(s.ttft) + 's'} | OUT ${tokens(s.output)}`
}
