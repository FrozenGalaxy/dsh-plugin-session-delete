/* DSH 0.2.x client module. All user-facing strings are English. */
window.__ModuleLoader__.load({
  id: '@huanlin/dsh-plugin-session-delete',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Modal, MenuItemButton } = ui
    const TrashIcon = ui.IconTrashOutlineRegular || ui.IconTrashOutlineMedium || ui.IconTrashOutline16
    const EVENT = 'chameleon:delete-session'
    const labels = {
      title: 'Delete session',
      cancel: 'Cancel',
      confirm: 'Permanently delete',
      deleting: 'Deleting session…',
      untitled: 'Untitled session',
      running: 'This session is running. Its active task will be stopped before deletion.',
      description: 'The session and its conversation history will be permanently deleted. This cannot be undone.',
      acknowledged: 'I understand that this action is permanent.',
      error: 'Could not delete the session',
      noSession: 'The selected session could not be found.',
      tooltip: 'Permanently delete session',
    }
    const colors = {
      primary: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }
    const buttonStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
      background: 'transparent', color: colors.secondary, cursor: 'pointer',
    }
    const actionStyle = {
      padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      background: 'transparent', border: '1px solid rgba(128,128,128,.4)', color: colors.primary,
    }
    let sessionsSvc = null
    let workspaceSvc = null

    function variants(raw) {
      const id = String(raw || '')
      const bare = id.startsWith('session-') ? id.slice(8) : id
      return [bare, `session-${bare}`]
    }

    // Delete only state keys whose final path segment is THIS session. Never
    // match generic numeric or substring keys (deleting session "1" must not
    // delete an unrelated preference like "dsh.panel.1").
    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    function clearClientSessionState(sessionId) {
      if (!sessionId) return
      try {
        const store = window.localStorage
        const bare = variants(sessionId)[0]
        const canonical = `session-${bare}`
        const token = new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(canonical)}(?![a-z0-9_-])`, 'i')
        const matchKey = (key) => key === canonical || key.endsWith(`.${canonical}`) || key.endsWith(`:${canonical}`)
        const keys = Array.from({ length: store.length }, (_, index) => store.key(index))
        for (const key of keys) {
          if (typeof key !== 'string') continue
          if (matchKey(key)) {
            store.removeItem(key)
          } else if (key === 'dsh.sessions.current' && variants(sessionId).includes(store.getItem(key))) {
            store.removeItem(key)
          }
        }
        // GENUI stores interaction records in a JSON map and their display
        // ordering in its `order` array, rather than standalone storage keys.
        const key = 'dsh.genui.interaction'
        const data = store.getItem(key)
        if (data) {
          const map = JSON.parse(data)
          if (map && typeof map === 'object' && !Array.isArray(map)) {
            let changed = false
            if (Array.isArray(map.order)) {
              const order = map.order.filter((entry) => typeof entry !== 'string' || !token.test(entry))
              if (order.length !== map.order.length) {
                map.order = order
                changed = true
              }
            }
            for (const entry of Object.keys(map)) {
              if (entry !== 'order' && token.test(entry)) {
                delete map[entry]
                changed = true
              }
            }
            if (changed) store.setItem(key, JSON.stringify(map))
          }
        }
      } catch { /* Client storage may be disabled; host deletion still succeeded. */ }
    }

    function dispatchDelete(sessionId, title, running) {
      if (!sessionId) return
      window.dispatchEvent(new CustomEvent(EVENT, {
        detail: { sessionId, title, running: running === true },
      }))
    }

    function HeaderDeleteButton(props) {
      const sessionId = props?.sessionId
      const snap = typeof props?.useSessions === 'function'
        ? props.useSessions((state) => state)
        : undefined
      const summary = snap?.byId?.[sessionId]
      const running = summary?.running === true
      const onClick = useCallback(
        () => dispatchDelete(sessionId, summary?.title, running),
        [sessionId, summary?.title, running],
      )
      return React.createElement('button', {
        type: 'button', title: labels.tooltip, 'aria-label': labels.tooltip,
        style: buttonStyle, onClick,
      }, TrashIcon ? React.createElement(TrashIcon, { size: 16 }) : '×')
    }

    // DSH 0.2.x has a dedicated row-menu slot. Use its sessionId, never a
    // title match or a MutationObserver over DOM class names.
    function SidebarDeleteMenuItem(props) {
      const sessionId = props?.sessionId
      const title = props?.displayTitle
      const useMenuOpenState = typeof props?.useMenuOpenState === 'function'
        ? props.useMenuOpenState : null
      const menuState = useMenuOpenState ? useMenuOpenState() : null
      const closeMenu = Array.isArray(menuState) ? menuState[1] : null
      const onSelect = useCallback(() => {
        if (typeof closeMenu === 'function') closeMenu(false)
        dispatchDelete(sessionId, title, false)
      }, [sessionId, title, closeMenu])
      if (!sessionId) return null
      if (MenuItemButton) {
        return React.createElement(MenuItemButton, {
          onSelect, danger: true, separatorBefore: true,
          icon: TrashIcon ? React.createElement(TrashIcon, { size: 16 }) : undefined,
        }, labels.title)
      }
      return React.createElement('button', {
        type: 'button', onClick: onSelect, style: { ...actionStyle, color: colors.danger },
      }, labels.title)
    }

    function wasCurrentSession(id) {
      const selected = workspaceSvc?.mainReference?.sessionId
      if (selected != null) return variants(id).includes(selected)
      const snap = sessionsSvc?.list?.getSnapshot?.()
      return variants(id).includes(snap?.current)
    }

    async function refreshAfterDelete(id, wasCurrent) {
      clearClientSessionState(id)
      try {
        if (typeof sessionsSvc?.refresh === 'function') await sessionsSvc.refresh()
        else if (typeof sessionsSvc?.refreshList === 'function') await sessionsSvc.refreshList()
      } catch { /* Keep the page and let the user refresh manually if needed. */ }
      if (!wasCurrent) return
      try {
        const snap = sessionsSvc?.list?.getSnapshot?.()
        const next = snap?.ids?.find((candidate) => !variants(id).includes(candidate))
        if (next && typeof workspaceSvc?.openSession === 'function') {
          workspaceSvc.openSession(next)
        } else if (!next && typeof workspaceSvc?.clearMain === 'function') {
          workspaceSvc.clearMain()
        }
      } catch { /* Navigation failures do not undo deletion. */ }
    }

    function DeleteDialog() {
      const [target, setTarget] = useState(null)
      const [ack, setAck] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      useEffect(() => {
        const handle = (event) => {
          const payload = event?.detail || {}
          if (typeof payload.sessionId !== 'string' || !payload.sessionId) return
          setTarget({ ...payload })
          setAck(false)
          setBusy(false)
          setError('')
        }
        window.addEventListener(EVENT, handle)
        return () => window.removeEventListener(EVENT, handle)
      }, [])
      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setAck(false)
        setError('')
      }, [busy])
      const confirm = useCallback(async () => {
        if (busy || !ack || !target?.sessionId) return
        setBusy(true)
        setError('')
        const selected = wasCurrentSession(target.sessionId)
        try {
          const response = await fetch('/__chameleon/session/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: target.sessionId }),
          })
          let result = null
          try { result = await response.json() } catch { /* Non-JSON host failure. */ }
          if (!response.ok || !result?.ok) {
            throw new Error(result?.error || `${labels.error} (HTTP ${response.status})`)
          }
          setTarget(null)
          await refreshAfterDelete(target.sessionId, selected)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [ack, busy, target])
      if (!target) return null
      const footer = [
        React.createElement('button', {
          key: 'cancel', type: 'button', style: actionStyle,
          disabled: busy, onClick: close,
        }, labels.cancel),
        React.createElement('button', {
          key: 'delete', type: 'button', disabled: busy || !ack,
          onClick: confirm,
          style: {
            ...actionStyle, marginLeft: 8, background: colors.danger, color: '#fff',
            border: `1px solid ${colors.danger}`, opacity: busy || !ack ? 0.5 : 1,
          },
        }, busy ? labels.deleting : labels.confirm),
      ]
      return React.createElement(Modal, {
        open: true, title: labels.title,
        closeLabel: labels.cancel, onClose: close,
        description: labels.description, footer,
      }, [
        React.createElement('div', {
          key: 'id', style: { marginBottom: 8, fontSize: 13, color: colors.secondary, overflowWrap: 'anywhere' },
        }, `${target.title || labels.untitled} (${target.sessionId})`),
        target.running ? React.createElement('p', {
          key: 'running', style: { color: colors.danger, fontSize: 13 },
        }, labels.running) : null,
        React.createElement('label', {
          key: 'check', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
        }, React.createElement('input', {
          type: 'checkbox', checked: ack, disabled: busy,
          onChange: (event) => setAck(event.target.checked),
        }), labels.acknowledged),
        error ? React.createElement('p', {
          key: 'error', role: 'alert', style: { color: colors.danger, fontSize: 12 },
        }, error) : null,
      ])
    }

    function apply(ctx) {
      sessionsSvc = ctx.get('sessions')
      workspaceSvc = ctx.get('uiWorkspace')
      if (!sessionsSvc) ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions })
      if (!workspaceSvc) ctx.inject(['uiWorkspace'], (sub) => { workspaceSvc = sub.uiWorkspace })
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'session-delete', order: 30,
      }, HeaderDeleteButton))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-delete:sidebar-menu-item', order: 500,
      }, SidebarDeleteMenuItem))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'session-delete-dialog', order: 100,
      }, DeleteDialog))
    }
    return { apply, inject: ['slots'], __test: { clearClientSessionState } }
  },
})
