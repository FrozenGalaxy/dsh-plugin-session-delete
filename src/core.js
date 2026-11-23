/**
 * Host-side session deletion primitives for DeepSeek Harness 0.2.x.
 * No DSH imports here: the filesystem and storage contracts can be unit tested
 * without installing a second, potentially incompatible Harness runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export class DeleteError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'DeleteError'
    this.status = status
  }
}

const UNSAFE_ID = /[\\/:*?"<>|\u0000-\u001f]/
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > 200 || id === '.' || id === '..') return null
  if (UNSAFE_ID.test(id) || /[. ]$/.test(id)) return null
  // Both spellings are used as individual path segments. In particular,
  // `session-..` must not turn into `..` when its bare variant is formed.
  if (id.startsWith('session-')) {
    const bare = id.slice('session-'.length)
    if (!bare || bare === '.' || bare === '..' || /[. ]$/.test(bare)) return null
  }
  return id
}

export function sessionIdVariants(id) {
  const checked = normalizeSessionId(id)
  if (!checked) throw new DeleteError('Invalid session ID', 400)
  const bare = checked.startsWith('session-') ? checked.slice(8) : checked
  return [...new Set([bare, `session-${bare}`])]
}

export function sessionsRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
}

function directoryEntries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) }
  catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
}

function isRealDirectory(dir) {
  try {
    // Refuse symlinks and junction-like paths: recursive deletion must not
    // follow a directory reference outside the DSH sessions root.
    const stat = fs.lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}

export function findSessionDirs(id) {
  const root = sessionsRoot()
  if (!isRealDirectory(root)) return []
  const result = []
  const variants = sessionIdVariants(id)
  for (const entry of directoryEntries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const projectDir = path.join(root, entry.name)
    if (!isRealDirectory(projectDir)) continue
    for (const variant of variants) {
      const candidate = path.join(projectDir, variant)
      if (isRealDirectory(candidate)) result.push(candidate)
    }
  }
  return result
}

function removeSessionDirs(id) {
  const dirs = findSessionDirs(id)
  for (const dir of dirs) fs.rmSync(dir, { force: true, recursive: true })
  return dirs.length
}

function getService(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined }
  catch { return undefined }
}

function tableFromDomain(ctx, domainName, tableName) {
  const storage = getService(ctx, 'storageDomain')
  const domain = storage && typeof storage.get === 'function' ? storage.get(domainName) : null
  return domain && typeof domain.table === 'function' ? domain.table(tableName) : null
}

function getAgents(ctx, id) {
  const agents = getService(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') return []
  const unique = new Set()
  for (const variant of sessionIdVariants(id)) {
    const agent = agents.get(variant)
    if (agent) unique.add(agent)
  }
  return [...unique]
}

async function stopAgent(ctx, id) {
  const agents = getAgents(ctx, id)
  if (agents.length === 0) return false
  // A legacy profile may have *both* ID spellings registered concurrently.
  // Refuse the whole deletion if any live agent cannot be stopped safely.
  if (agents.some((agent) => typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function')) {
    throw new DeleteError('Cannot safely stop the running session', 409)
  }
  await Promise.all(agents.map((agent) => agent.cancel({ kind: 'user' })))
  let timeout
  try {
    await Promise.race([
      Promise.all(agents.map((agent) => Promise.resolve().then(() => agent.whenIdle()))),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new DeleteError('Session is still running; retry after it stops', 409)), 15000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
  return true
}

async function detachSession(ctx, id) {
  const sessions = getService(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let removed = false
  for (const variant of sessionIdVariants(id)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') await sessions.flush(session)
    const store = sessions.store
    const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
    if (entry === undefined) {
      // Do not touch persistence while an attached session may still write.
      throw new DeleteError('Session is live but cannot be detached safely', 409)
    }
    if (typeof sessions.detachEntered === 'function') {
      await sessions.detachEntered(entry)
    } else if (typeof store.delete === 'function') {
      store.delete(variant)
      if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
        sessions.attachments.delete(entry.session)
      }
    } else {
      throw new DeleteError('No safe session detachment API is available', 409)
    }
    removed = true
  }
  return removed
}

async function removeProjection(ctx, id) {
  const table = tableFromDomain(ctx, 'session_projcache', 'sessions')
  if (!table) return false
  let removed = false
  for (const variant of sessionIdVariants(id)) {
    if (table.get(variant) !== undefined) {
      await table.delete(variant)
      removed = true
    }
  }
  return removed
}

async function removeWorkspace(ctx, id) {
  const variants = sessionIdVariants(id)
  let changed = false
  const registry = getService(ctx, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    for (const variant of variants) {
      if (Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(variant)
          && typeof registry.unpinSession === 'function') {
        await registry.unpinSession(variant)
        changed = true
      }
      if (Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(variant)
          && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(variant)
        changed = true
      }
      for (const workspace of registry.list() || []) {
        if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(variant)
            && typeof workspace.detachSession === 'function') {
          await workspace.detachSession(variant)
          changed = true
        }
      }
    }
  }
  // The raw domain is also used for older profiles and to remove stale entries
  // the registry did not expose. Always run after the registry operations.
  const storage = getService(ctx, 'storageDomain')
  const domain = storage && typeof storage.get === 'function' ? storage.get('workspace') : null
  if (!domain) return changed
  if (typeof domain.table === 'function') {
    const table = domain.table('workspaces')
    if (table && typeof table.entries === 'function') {
      for (const [key, record] of table.entries()) {
        if (!record || !Array.isArray(record.sessionIds)) continue
        const next = record.sessionIds.filter((x) => !variants.includes(x))
        if (next.length !== record.sessionIds.length) {
          await table.put(key, { ...record, sessionIds: next })
          changed = true
        }
      }
    }
  }
  const global = domain.global
  if (global && typeof global.get === 'function' && typeof global.set === 'function') {
    const state = global.get()
    if (state && typeof state === 'object') {
      let changedGlobal = false
      const next = { ...state }
      for (const property of ['pinnedSessionIds', 'archivedSessionIds']) {
        if (!Array.isArray(state[property])) continue
        next[property] = state[property].filter((x) => !variants.includes(x))
        if (next[property].length !== state[property].length) changedGlobal = true
      }
      if (changedGlobal) {
        await global.set(next)
        changed = true
      }
    }
  }
  return changed
}

export async function deleteSessionCore(ctx, rawId) {
  const id = normalizeSessionId(rawId)
  if (!id) throw new DeleteError('Invalid session ID', 400)

  const stopped = await stopAgent(ctx, id)
  const detached = await detachSession(ctx, id)
  // Delete the authoritative log before workspace accounting, or a partial
  // filesystem failure can detach a still-persisted session from its group.
  const removedFirst = removeSessionDirs(id)
  const projectionRemoved = await removeProjection(ctx, id)
  const removedSecond = removeSessionDirs(id)
  await new Promise((resolve) => setImmediate(resolve))
  const removedThird = removeSessionDirs(id)
  if (findSessionDirs(id).length !== 0) {
    throw new DeleteError('Session logs could not be fully removed', 500)
  }
  const workspaceRemoved = await removeWorkspace(ctx, id)
  const logsRemoved = removedFirst + removedSecond + removedThird
  if (!logsRemoved && !projectionRemoved && !workspaceRemoved && !detached) {
    throw new DeleteError('Session not found', 404)
  }
  return {
    sessionId: id,
    stopped,
    detached,
    dirRemoved: logsRemoved > 0,
    projRemoved: projectionRemoved,
    workspaceRemoved,
  }
}

export function listSessions(ctx) {
  const table = tableFromDomain(ctx, 'session_projcache', 'sessions')
  if (!table || typeof table.entries !== 'function') return []
  const result = []
  for (const [id, record] of table.entries()) {
    const title = record?.rows?.title?.val
    result.push({
      sessionId: id,
      title: typeof title === 'string' ? title : null,
      running: getAgents(ctx, id).length > 0,
    })
  }
  return result
}
