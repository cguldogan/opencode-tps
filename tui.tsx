/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { Tracker, line, rate, tokens } from './tracker.ts'

const tui: TuiPlugin = async (api) => {
  const tracker = new Tracker()
  const [tick, setTick] = createSignal(0)
  const loaded = new Set<string>()
  const queued = new Set<string>()
  const failed = new Map<string, number>()
  const queue: string[] = []
  let workers = 0, disposed = false
  const notify = () => { if (!disposed) setTick((v) => v + 1) }
  const selected = () => {
    const route = api.route.current
    return route.name === 'session' && typeof route.params?.sessionID === 'string' ? route.params.sessionID : undefined
  }
  const remember = (id: string) => {
    const seen = new Set<string>()
    while (!seen.has(id)) {
      seen.add(id)
      const session = api.state.session.get(id)
      if (!session) break
      tracker.session(session)
      if (!session.parentID) break
      id = session.parentID
    }
  }
  const schedule = (id: string) => {
    if (disposed || loaded.has(id) || queued.has(id) || Date.now() - (failed.get(id) ?? 0) < 15000) return
    queued.add(id); queue.push(id); drain()
  }
  const load = async (id: string) => {
    try {
      const options = { signal: api.lifecycle.signal }
      const [history, children] = await Promise.all([
        api.client.session.messages({ sessionID: id }, options),
        api.client.session.children({ sessionID: id }, options),
      ])
      if (disposed) return
      if (!history.data || !children.data) throw new Error('History unavailable')
      for (const { info, parts } of history.data) {
        if (info.role !== 'assistant') continue
        // Merge persisted parts into records that may have appeared live while
        // this request was in flight. A newer live completion remains authoritative.
        const current = tracker.records.get(info.id)
        if (!current || current.completed === undefined || info.time.completed === undefined || info.time.completed >= current.completed) {
          tracker.message(info)
        }
        for (const part of parts) tracker.part(part, undefined, true)
      }
      for (const child of children.data) { tracker.session(child); schedule(child.id) }
      loaded.add(id); failed.delete(id)
    } catch {
      if (!disposed) failed.set(id, Date.now())
    } finally {
      queued.delete(id); notify()
    }
  }
  function drain() {
    while (!disposed && workers < 3 && queue.length) {
      const id = queue.shift()!
      workers++
      void load(id).finally(() => { workers--; drain() })
    }
  }
  const off = [
    api.event.on('session.created', (e) => {
      tracker.session(e.properties.info)
      const id = selected()
      if (id && tracker.root(e.properties.info.id) === tracker.root(id)) schedule(e.properties.info.id)
    }),
    api.event.on('session.updated', (e) => tracker.session(e.properties.info)),
    api.event.on('session.deleted', (e) => {
      tracker.removeSession(e.properties.info.id); loaded.delete(e.properties.info.id)
    }),
    api.event.on('message.updated', (e) => tracker.message(e.properties.info)),
    api.event.on('message.part.updated', (e) => tracker.part(e.properties.part, e.properties.time)),
    api.event.on('message.part.delta', (e) => {
      const p = e.properties
      tracker.delta(p.sessionID, p.messageID, p.partID, p.field, p.delta, Date.now())
    }),
    api.event.on('message.removed', (e) => tracker.removeMessage(e.properties.messageID)),
    api.event.on('message.part.removed', (e) => tracker.records.get(e.properties.messageID)?.parts.delete(e.properties.partID)),
    api.event.on('session.status', (e) => tracker.status(e.properties.sessionID, e.properties.status.type)),
    api.event.on('session.error', (e) => { if (e.properties.sessionID) tracker.status(e.properties.sessionID, 'error') }),
  ]
  const timer = setInterval(() => {
    const id = selected()
    if (id) {
      remember(id)
      schedule(id); schedule(tracker.root(id))
      for (const child of tracker.tree(tracker.root(id))) {
        const status = api.state.session.status(child)
        if (status) tracker.status(child, status.type)
        if (failed.has(child)) schedule(child)
      }
    }
    notify()
  }, 500)

  const snapshot = createMemo(() => {
    tick()
    const id = selected()
    if (!id) return undefined
    const now = Date.now(), ids = tracker.tree(tracker.root(id))
    const busy = [...ids].filter((sid) => ['busy', 'retry'].includes(tracker.statuses.get(sid) ?? '')).length
    return {
      id, ids, busy, own: tracker.stats(new Set([id]), now), all: tracker.stats(ids, now),
      child: !!tracker.sessions.get(id)?.parentID,
      loading: [...ids].some((sid) => queued.has(sid)),
      partial: [...ids].some((sid) => failed.has(sid)),
    }
  })

  function Footer() {
    return <Show when={snapshot()}>{(s) =>
      <box flexDirection="column" paddingLeft={2} paddingRight={1} flexShrink={0} backgroundColor={api.theme.current.backgroundPanel}>
        <text fg={api.theme.current.text}>
          {`${s().child ? 'AGENT' : 'MAIN'}  ${line(s().own)}${s().loading ? ' | loading history…' : s().partial ? ' | history incomplete; retrying' : ''}`}
        </text>
        <Show when={s().ids.size > 1}>
          <text fg={api.theme.current.textMuted}>
            {`TREE   TPS ${s().all.streaming ? '~' + rate(s().all.live) : '—'} | ${s().busy} busy / ${s().ids.size} sessions | ${s().all.streaming} streaming | OUT ${tokens(s().all.output)} | /llmstats`}
          </text>
        </Show>
      </box>
    }</Show>
  }

  function Details() {
    const [refresh, setRefresh] = createSignal(0)
    const interval = setInterval(() => setRefresh((n) => n + 1), 1000)
    onCleanup(() => clearInterval(interval))
    const options = () => {
      refresh(); tick()
      const s = snapshot()
      if (!s) return []
      return [...s.ids].map((id) => {
        const stats = tracker.stats(new Set([id]), Date.now())
        const session = tracker.sessions.get(id)
        const last = [...tracker.records.values()].filter((r) => r.sessionID === id && r.assistant).at(-1)
        return {
          value: id,
          title: `${id === s.id ? '› ' : ''}${session?.parentID ? last?.agent ?? 'Agent' : 'Main'} · ${session?.title ?? id}`,
          description: `${tracker.statuses.get(id) ?? 'idle'} | ${line(stats)}`,
          footer: `${last?.model ?? 'Model unavailable'} | ${stats.responses} responses; ${stats.measured} timed | IN ${tokens(stats.input)} | CACHE ${tokens(stats.cache)}`,
        }
      })
    }
    return <api.ui.DialogSelect
      title="LLM stats · ~ estimated live TPS · AVG measured generation · TTFT mean first response"
      placeholder="Find an agent; select to open its session"
      options={options()}
      onSelect={(option) => { api.ui.dialog.clear(); api.route.navigate('session', { sessionID: option.value }) }}
    />
  }
  // Compatibility command API is supported by the installed OpenCode version.
  const unregister = api.command?.register(() => [{
    title: 'LLM stats: all agents', value: 'oc-agent-stats.show', category: 'Session',
    slash: { name: 'llmstats' },
    onSelect: () => { api.ui.dialog.replace(() => <Details />); api.ui.dialog.setSize('xlarge') },
  }])
  api.slots.register({ slots: { app_bottom: () => <Footer /> } })
  api.lifecycle.onDispose(() => {
    disposed = true; clearInterval(timer); off.forEach((fn) => fn()); unregister?.(); queue.length = 0
  })
}

export default { id: 'oc-agent-stats-local', tui } satisfies TuiPluginModule
