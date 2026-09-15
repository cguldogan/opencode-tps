import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message, Part } from '@opencode-ai/sdk/v2'
import { Tracker, line, unionDuration } from './tracker.ts'

function message(id = 'm1', sessionID = 'main', completed?: number, output = 100) {
  return { id, sessionID, role: 'assistant', time: { created: 1000, completed }, agent: 'build',
    providerID: 'local', modelID: 'model', tokens: { output, reasoning: 20, input: 1000, cache: { read: 200, write: 0 } },
  } as Message
}
function text(id = 'p1', messageID = 'm1', sessionID = 'main', start = 2000, end?: number) {
  return { id, messageID, sessionID, type: 'text', text: '', time: { start, end } } as Part
}
function tool(status: string, at = 4000) {
  return { id: 'tool1', messageID: 'm1', sessionID: 'main', type: 'tool', tool: 'task',
    state: { status, time: { start: at, end: 64000 } } } as Part
}

test('parallel sessions keep independent live rates and tree sums', () => {
  const t = new Tracker()
  t.session({ id: 'main', title: 'Main' })
  for (const id of ['a', 'b']) {
    t.session({ id, parentID: 'main', title: id }); t.message(message(id, id))
    t.part(text(id, id, id)); t.delta(id, id, id, 'text', 'x'.repeat(500), 2000)
  }
  assert.equal(t.stats(new Set(['a']), 2500).live, 100)
  assert.equal(t.stats(t.tree('main'), 2500).live, 200)
  assert.equal(t.stats(new Set(['main']), 2500).live, 0)
  assert.equal(t.root('b'), 'main')
})
test('background deltas need no currently mounted UI parts', () => {
  const t = new Tracker(); t.message(message('m', 'background'))
  t.delta('background', 'm', 'unmounted', 'text', 'a'.repeat(500), 2000)
  assert.equal(t.stats(new Set(['background']), 2300).live, 100)
})
test('tiny SSE chunks do not round up to a token apiece', () => {
  const t = new Tracker(); t.message(message())
  for (let i = 0; i < 100; i++) t.delta('main', 'm1', 'p1', 'text', 'a', 2000)
  assert.ok(Math.abs(t.stats(new Set(['main']), 2500).live - 20) < 1e-9)
  assert.equal(t.records.get('m1')!.samples.length, 1)
})
test('completion is idempotent and token corrections replace totals', () => {
  const t = new Tracker(); t.part(text('p1', 'm1', 'main', 2000, 4000))
  for (let i = 0; i < 3; i++) t.message(message('m1', 'main', 4500))
  const s = t.stats(new Set(['main']), 4500)
  assert.equal(s.responses, 1); assert.equal(s.output, 120); assert.equal(s.avg, 60); assert.equal(s.ttft, 1)
  t.message(message('m1', 'main', 4500, 200))
  assert.equal(t.stats(new Set(['main']), 4500).output, 220)
})
test('60 seconds of tool execution do not count as generation', () => {
  const t = new Tracker(); t.message(message())
  t.part(text('p1', 'm1', 'main', 2000, 3000))
  t.part(tool('pending'), 3000); t.part(tool('running'), 4000)
  t.part(tool('completed'), 64000); t.message(message('m1', 'main', 65000))
  const s = t.stats(new Set(['main']), 65000)
  assert.equal(s.duration, 2000); assert.equal(s.avg, 60)
})
test('a completed tool does not clear other streams', () => {
  const t = new Tracker(); t.message(message()); t.message(message('m2'))
  t.delta('main', 'm2', 'p2', 'text', 'x'.repeat(500), 64000)
  t.part(tool('completed'), 64000)
  assert.equal(t.stats(new Set(['main']), 64500).live, 100)
})
test('overlapping text, reasoning and tool spans are merged', () => {
  assert.equal(unionDuration([{ start: 1, end: 10 }, { start: 5, end: 12 }, { start: 20, end: 25 }]), 16)
})
test('historical tool-only records have usage but no invented rate', () => {
  const t = new Tracker(); t.message(message('m1', 'main', 65000))
  t.part(tool('completed'), undefined, true)
  const s = t.stats(new Set(['main']), 65000)
  assert.equal(s.output, 120); assert.equal(s.avg, undefined); assert.equal(s.ttft, undefined)
})
test('historical text restores rate without replaying live TPS', () => {
  const t = new Tracker(); t.message(message('m1', 'main', 5000))
  t.part(text('p1', 'm1', 'main', 2000, 4000), undefined, true)
  const s = t.stats(new Set(['main']), 5000)
  assert.equal(s.avg, 60); assert.equal(s.live, 0); assert.equal(s.ttft, 1)
})
test('live rate expires, error and retry clear it, late deltas stay ignored', () => {
  const t = new Tracker(); t.message(message())
  t.delta('main', 'm1', 'p1', 'text', 'x'.repeat(500), 2000)
  assert.equal(t.stats(new Set(['main']), 3600).streaming, 0)
  t.status('main', 'retry'); assert.equal(t.records.get('m1')!.samples.length, 0)
  t.message(message('m1', 'main', 4000)); t.delta('main', 'm1', 'p1', 'text', 'x', 5000)
  assert.equal(t.stats(new Set(['main']), 5100).streaming, 0)
})
test('nested descendants included, unrelated sessions excluded, cyclic metadata terminates', () => {
  const t = new Tracker()
  t.session({ id: 'main', title: '' }); t.session({ id: 'a', parentID: 'main', title: '' })
  t.session({ id: 'b', parentID: 'a', title: '' }); t.session({ id: 'other', title: '' })
  assert.deepEqual([...t.tree('main')], ['main', 'a', 'b'])
  t.session({ id: 'main', parentID: 'b', title: '' }); assert.equal(t.root('main'), 'main')
})
test('reasoning counts once, weighted averages use tokens over generation duration', () => {
  const t = new Tracker()
  t.message(message('m1', 'main', 4000, 80)); t.part(text('p1', 'm1', 'main', 2000, 3000))
  t.message(message('m2', 'main', 8000, 180)); t.part(text('p2', 'm2', 'main', 2000, 6000))
  const s = t.stats(new Set(['main']), 9000)
  assert.equal(s.output, 300); assert.equal(s.avg, 60); assert.equal(s.responses, 2)
})
test('removal clears measurements and empty stats format safely', () => {
  const t = new Tracker(); t.message(message('m1', 'main', 4000))
  t.removeSession('main'); assert.equal(t.records.size, 0)
  assert.equal(line(t.stats(new Set(['main']), 5000)), 'TPS — | AVG — | TTFT — | OUT 0')
})
