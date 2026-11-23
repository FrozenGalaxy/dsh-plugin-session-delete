import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('DSH 0.2.x plugin manifest does not declare incompatible 0.1.x peers', () => {
  assert.equal(pkg.name, '@huanlin/dsh-plugin-session-delete')
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.match(pkg.engines.dsh, /0\.2\.2-rc\.5/)
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], undefined)
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('all text assets and source comments are English-only', () => {
  const files = ['README.md', 'src/index.js', 'src/core.js', 'src/client.js',
    'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']
  for (const file of files) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(contents, /[\u3400-\u9fff]/u, `${file} has Chinese characters`)
  }
})

test('documentation contains no hardcoded personal home-directory paths', () => {
  const files = ['README.md', 'NOTICE.md', 'package.json', 'cordis.patch.yml']
  for (const file of files) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8')
    assert.doesNotMatch(contents, /[A-Za-z]:\\Users\\(?!<username>)[^\\\s`"']+/i, `${file} contains a specific Windows user path`)
    assert.doesNotMatch(contents, /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, `${file} contains a specific Unix user path`)
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  assert.match(readme, /%USERPROFILE%/)
})

test('client registers the DSH 0.2.x header, sidebar menu and overlay slots', () => {
  const code = fs.readFileSync(path.join(root, 'src/client.js'), 'utf8')
  let moduleDefinition
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { moduleDefinition = m } } } }
  vm.runInNewContext(code, sandbox)
  assert.equal(moduleDefinition.id, pkg.name)
  const React = {
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useState: (initial) => [initial, () => undefined],
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const MenuItemButton = () => undefined
  const plugin = moduleDefinition.factory((name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, MenuItemButton }
    throw new Error(`Unexpected import: ${name}`)
  })
  const registered = new Map()
  plugin.apply({
    get: () => undefined,
    inject: () => undefined,
    slots: {
      inject: (_slotName, cb) => cb(),
      register: (config, component) => { registered.set(config.name, { config, component }) },
    },
  })
  assert.deepEqual([...registered.keys()], [
    'conversation.session.header.actions',
    'sidebar.workspaces.session.menu.item',
    'shell.overlay',
  ])
  const menu = registered.get('sidebar.workspaces.session.menu.item')
  assert.equal(menu.config.order, 500)
  const element = menu.component({ sessionId: 'session-123', displayTitle: 'Test' })
  assert.equal(element.type, MenuItemButton)
  assert.equal(element.children[0], 'Delete session')
})

test('browser cleanup only removes the deleted session, including GENUI order', () => {
  const code = fs.readFileSync(path.join(root, 'src/client.js'), 'utf8')
  let moduleDefinition
  const entries = new Map([
    ['dsh.panel.1', 'keep this numbered preference'],
    ['dsh.conversation.session-1', 'deleted draft'],
    ['dsh.conversation.session-11', 'keep neighboring draft'],
    ['dsh-sidebar:v1:session-1', 'deleted panel'],
    ['other-plugin:session-1', 'deleted per-session state'],
    ['dsh.sessions.current', 'session-1'],
    ['dsh.genui.interaction', JSON.stringify({
      order: ['f:session-1:dom:0', 'f:session-11:dom:1'],
      'f:session-1:dom:0': { x: true },
      'f:session-11:dom:1': { x: false },
    })],
  ])
  const storage = {
    get length() { return entries.size },
    key(index) { return [...entries.keys()][index] || null },
    getItem(key) { return entries.get(key) ?? null },
    setItem(key, value) { entries.set(key, value) },
    removeItem(key) { entries.delete(key) },
  }
  vm.runInNewContext(code, {
    window: { localStorage: storage, __ModuleLoader__: { load: (m) => { moduleDefinition = m } } },
  })
  const plugin = moduleDefinition.factory((name) => {
    if (name === 'react') return { useCallback: (fn) => fn, useEffect: () => undefined, useState: () => [] }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: () => null, MenuItemButton: () => null }
    throw new Error(`Unknown client dependency ${name}`)
  })
  plugin.__test.clearClientSessionState('session-1')
  assert.equal(entries.has('dsh.conversation.session-1'), false)
  assert.equal(entries.has('dsh-sidebar:v1:session-1'), false)
  assert.equal(entries.has('other-plugin:session-1'), false)
  assert.equal(entries.has('dsh.sessions.current'), false)
  assert.equal(entries.get('dsh.panel.1'), 'keep this numbered preference')
  assert.equal(entries.get('dsh.conversation.session-11'), 'keep neighboring draft')
  const genui = JSON.parse(entries.get('dsh.genui.interaction'))
  assert.deepEqual(genui.order, ['f:session-11:dom:1'])
  assert.deepEqual(genui['f:session-11:dom:1'], { x: false })
  assert.equal(genui['f:session-1:dom:0'], undefined)
})
