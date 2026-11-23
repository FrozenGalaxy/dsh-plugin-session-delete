import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deleteSessionCore, findSessionDirs, normalizeSessionId, sessionIdVariants, listSessions } from '../src/core.js'

function mockTable(rows) {
  const map = new Map(rows)
  return {
    get: (id) => map.get(id),
    put: async (id, record) => { map.set(id, record) },
    delete: async (id) => { map.delete(id) },
    entries: () => map.entries(),
    values: () => map.values(),
    map,
  }
}

function fixture(root, id, options = {}) {
  process.env.DSH_HOME = root
  const dir = path.join(root, 'sessions', 'project-one', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), 'test log')
  const proj = mockTable([[id, { rows: { title: { val: 'Test conversation' } } }]])
  const workspaces = mockTable([['project-one', { sessionIds: [id, 'other-session'] }]])
  let state = { archivedSessionIds: [id], pinnedSessionIds: [id] }
  const domain = {
    table: (name) => name === 'workspaces' ? workspaces : null,
    global: {
      get: () => state,
      set: async (next) => { state = next },
    },
  }
  const services = {
    agents: { get: () => options.agent || undefined },
    sessions: options.sessions || { get: () => undefined },
    storageDomain: {
      get: (name) => name === 'session_projcache'
        ? { table: () => proj }
        : name === 'workspace' ? domain : undefined,
    },
  }
  if (options.registry) services.workspaceRegistry = options.registry
  return {
    ctx: { get: (name) => services[name] },
    dir, proj, workspaces,
    state: () => state,
  }
}

async function withHome(fn) {
  const previous = process.env.DSH_HOME
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-delete-test-'))
  try { await fn(root) }
  finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('unsafe session ID values are rejected', () => {
  for (const value of ['../evil', 'x/y', 'a\\b', '.', '..', 'id.', 'x:bad', '', 'session-', 'session-.', 'session-..']) {
    assert.equal(normalizeSessionId(value), null, value)
  }
  assert.equal(normalizeSessionId('custom-counter-123'), 'custom-counter-123')
  assert.deepEqual(sessionIdVariants('session-abc'), ['abc', 'session-abc'])
})

test('removes logs, projections, workspace ownership and pin/archive state', async () => withHome(async (root) => {
  const id = 'session-aabbccdd-1234-1234-1234-112233445566'
  const f = fixture(root, id)
  const result = await deleteSessionCore(f.ctx, id)
  assert.equal(result.dirRemoved, true)
  assert.equal(result.projRemoved, true)
  assert.equal(result.workspaceRemoved, true)
  assert.equal(fs.existsSync(f.dir), false)
  assert.equal(f.proj.map.has(id), false)
  assert.deepEqual(f.workspaces.map.get('project-one').sessionIds, ['other-session'])
  assert.deepEqual(f.state().archivedSessionIds, [])
  assert.deepEqual(f.state().pinnedSessionIds, [])
}))

test('cleans both bare and prefixed variants without touching neighboring sessions', async () => withHome(async (root) => {
  const id = 'c0ffeeaa-1111-2222-3333-444455556666'
  const f = fixture(root, id)
  const prefixed = path.join(path.dirname(f.dir), `session-${id}`)
  fs.mkdirSync(prefixed)
  const other = path.join(path.dirname(f.dir), 'other-session')
  fs.mkdirSync(other)
  const result = await deleteSessionCore(f.ctx, `session-${id}`)
  assert.equal(result.dirRemoved, true)
  assert.equal(fs.existsSync(f.dir), false)
  assert.equal(fs.existsSync(prefixed), false)
  assert.equal(fs.existsSync(other), true)
}))

test('fails closed if an agent cannot be brought to idle', async () => withHome(async (root) => {
  const id = 'session-active-123'
  let stopped = 0
  const f = fixture(root, id, {
    agent: { cancel: () => { stopped += 1 } },
  })
  await assert.rejects(() => deleteSessionCore(f.ctx, id), /Cannot safely stop/)
  assert.equal(stopped, 0)
  assert.equal(fs.existsSync(f.dir), true)
  assert.equal(f.proj.map.has(id), true)
}))

test('uses the live workspace registry before touching the raw storage domain', async () => withHome(async (root) => {
  const id = 'session-xyz-123'
  const calls = []
  const workspace = { sessionIds: [id], detachSession: async (x) => calls.push(['detach', x]) }
  const registry = {
    pinnedSessionIds: [id], archivedSessionIds: [id],
    unpinSession: async (x) => calls.push(['unpin', x]),
    unarchiveSession: async (x) => calls.push(['unarchive', x]),
    list: () => [workspace],
  }
  const f = fixture(root, id, { registry })
  await deleteSessionCore(f.ctx, id)
  assert.deepEqual(calls, [['unpin', id], ['unarchive', id], ['detach', id]])
  assert.deepEqual(f.workspaces.map.get('project-one').sessionIds, ['other-session'])
}))

test('refuses symlinked project directories and does not follow them', async () => withHome(async (root) => {
  const id = 'session-abcd'
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symlink-target-'))
  try {
    process.env.DSH_HOME = root
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(outside, id))
    fs.symlinkSync(outside, path.join(root, 'sessions', 'linked-project'), 'dir')
    assert.deepEqual(findSessionDirs(id), [])
    assert.equal(fs.existsSync(path.join(outside, id)), true)
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
}))

test('unknown sessions report not found and listSessions exposes titles', async () => withHome(async (root) => {
  const id = 'test-session-456'
  const f = fixture(root, id)
  assert.deepEqual(listSessions(f.ctx), [{ sessionId: id, title: 'Test conversation', running: false }])
  await assert.rejects(() => deleteSessionCore(f.ctx, 'nonexistent-123'), /Session not found/)
  assert.equal(fs.existsSync(f.dir), true)
}))

test('a prefixed dot segment can never escape the session directory', async () => withHome(async (root) => {
  const f = fixture(root, 'session-safe')
  for (const dangerous of ['session-.', 'session-..']) {
    await assert.rejects(() => deleteSessionCore(f.ctx, dangerous), /Invalid session ID/)
    assert.equal(fs.existsSync(path.join(root, 'sessions')), true)
    assert.equal(fs.existsSync(f.dir), true)
  }
}))

test('all active agents registered under either spelling must settle', async () => withHome(async (root) => {
  const id = 'session-both-agents'
  const calls = []
  const agents = new Map([
    [id, { cancel: async () => calls.push('prefixed cancel'), whenIdle: async () => calls.push('prefixed idle') }],
    ['both-agents', { cancel: async () => calls.push('bare cancel'), whenIdle: async () => calls.push('bare idle') }],
  ])
  const f = fixture(root, id)
  const oldGet = f.ctx.get
  f.ctx.get = (name) => name === 'agents' ? { get: (variant) => agents.get(variant) } : oldGet(name)
  const result = await deleteSessionCore(f.ctx, id)
  assert.equal(result.stopped, true)
  assert.deepEqual(calls.slice(0, 2).sort(), ['bare cancel', 'prefixed cancel'])
  assert.deepEqual(calls.slice(2).sort(), ['bare idle', 'prefixed idle'])
}))
