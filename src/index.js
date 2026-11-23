/** Host entry point for the original session-delete Cordis plugin. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { deleteSessionCore, DeleteError, listSessions } from './core.js'

export const name = 'chameleon-session-delete'
export const inject = ['tools']
const BODY_LIMIT = 64 * 1024

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function forbidCrossOrigin(req) {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return true
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host !== String(req.headers.host || '')
  } catch {
    return true
  }
}

async function parseJsonBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new DeleteError('Expected application/json', 415)
  }
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > BODY_LIMIT) {
        fail(new DeleteError('Request body is too large', 413))
        req.pause()
      } else chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new DeleteError('Request aborted', 400)))
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('Expected a JSON object')
        }
        resolve(result)
      } catch {
        reject(new DeleteError('Invalid JSON body', 400))
      }
    })
  })
}

function route(host, targetCtx, path, method, handler) {
  targetCtx.effect(() => host.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (forbidCrossOrigin(req)) return json(res, 403, { ok: false, error: 'Cross-origin request denied' })
      if (req.method !== method) return json(res, 405, { ok: false, error: 'Method not allowed' })
      try {
        const result = await handler(req)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        const status = error instanceof DeleteError ? error.status : 500
        json(res, status, { ok: false, error: error instanceof Error ? error.message : 'Unknown error' })
      }
    },
  }))
}

function registerHttp(host, ctx, targetCtx) {
  route(host, targetCtx, '/__chameleon/session/list', 'GET', () => ({ sessions: listSessions(ctx) }))
  route(host, targetCtx, '/__chameleon/session/delete', 'POST', async (req) => {
    const args = await parseJsonBody(req)
    if (typeof args.sessionId !== 'string') throw new DeleteError('sessionId is required', 400)
    return deleteSessionCore(ctx, args.sessionId)
  })
}

export function apply(ctx) {
  const web = ctx.get('webServer')
  if (web) registerHttp(web, ctx, ctx)
  else ctx.inject(['webServer'], (child) => registerHttp(child.webServer, ctx, child))

  ctx.tools.register(defineTool({
    name: 'workbench_session_delete',
    description: 'Permanently delete a DSH session and its conversation log. Cancels an active agent, detaches the live session, deletes the log and projection row, and removes workspace references. This action cannot be undone. Only call when the user explicitly requests deletion.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session ID to delete (bare ID or session- prefixed ID).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      try {
        const result = await deleteSessionCore(ctx, args.sessionId)
        return `Permanently deleted session ${result.sessionId}. Logs: ${result.dirRemoved}; projection: ${result.projRemoved}; workspace: ${result.workspaceRemoved}.`
      } catch (error) {
        return `Session deletion failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))
}
