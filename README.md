# DeepSeek Harness Session Delete (English, DSH 0.2.x)

Delete conversations permanently from DeepSeek Harness on desktop or the web.
This is an English-only, locally reconstructed port of
[`lsz-asd/dsh-plugin-session-delete`](https://github.com/lsz-asd/dsh-plugin-session-delete).
The original package name and plugin configuration row are retained.

**Primary target:** DSH `0.2.2-rc.5`. The manifest permits later pre-0.3 versions, but those require separate validation. The original v0.3.1
required `@deepseek-ai/dsh-tools@^0.1.0-rc.6` and DSH 0.2.2 refused to load
it. This port uses DSH 0.2.x plugin-manifest metadata and its newer UI slots.

## Features

- Trash action in the conversation header.
- **Delete session** action at the bottom of the sidebar session menu.
- Explicit confirmation checkbox, permanent-deletion warning, and active-task notice.
- Cancels registered live agents under both supported session-ID spellings and waits for them to become idle before removing files.
- Deletes session logs, projection-cache records, and workspace ownership,
  pinned, and archived references without a full page reload.
- Refreshes the sidebar with `sessions.refresh()` and uses
  `uiWorkspace.openSession()` / `clearMain()` for navigation.
- Deletes per-session browser UI state, including GENUI interaction order, after a confirmed host-side deletion without touching unrelated preferences.
- Agent tool named `workbench_session_delete`.
- English user interface, error messages, code comments, and documentation.

**This is a permanent delete operation, not archive or recycle bin.** Back up
important sessions first. The agent tool can also initiate deletion when given
an explicit instruction to do so.

## Install (Windows desktop)

1. Extract the ZIP. It contains the folder `dsh-plugin-session-delete`.
2. Stop the desktop profile before replacing an installed copy.
3. Copy the folder to `%USERPROFILE%\.dsh\dsh-plugin-session-delete` (normally `C:\Users\<username>\.dsh\dsh-plugin-session-delete`).
4. In `cmd.exe`, run:

```bat
cd /d "%USERPROFILE%\.dsh"
dsh plugin --profile desktop add "file:%USERPROFILE%\.dsh\dsh-plugin-session-delete"
```

Restart the desktop profile after installation.

To validate that the plugin row was included in the configuration:

```bat
dsh --profile desktop --dump-config
```

**Do not run `allow-version`** for the old v0.3.1 package. It merely overrides
an installation guard and does not repair incompatible APIs.

## Install notes

The package has no outdated `@deepseek-ai/dsh-tools` peer range. It instead
uses `dsh.manifestVersion: 1`, supported client injection modules, and an
`engines.dsh` range beginning at `0.2.2-rc.5`. DSH supplies its own runtime
services. Do not independently install or downgrade Harness internals into the
plugin folder.

The original package ID (`@huanlin/dsh-plugin-session-delete`) stays the same,
so the old plugin can be upgraded rather than installed under a second ID.

## Official API references

The official [API package map](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/README.md)
explains the Client-to-Host Remote layer. Its
[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)
and [Workspace Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/workspace-controller/README.md)
expose normal Session and Workspace operations to the UI. They do **not**
document a public permanent-session-deletion Remote method. Therefore this
external plugin must use its own same-origin Host HTTP route, the Host
[session store](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md),
and the live [workspace registry](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/README.md)
for bookkeeping. These are less stable implementation-level interfaces than
published Remote methods, and are why a real-profile compatibility test is
necessary before relying on deletion.

## Test

```sh
npm test
npm run check
```

Tests use Node's built-in test runner, no external packages, and temporary
session directories. They cover path traversal prevention, storage cleanup,
agent-stop failures, dual ID spellings, source-language checks, and UI slot
registration. They do not launch a real DSH desktop runtime.

## Compatibility and limitations

- **Not yet smoke-tested against your actual desktop installation.** Syntax
  checks and isolated tests are not a substitute for a real-profile test.
- Designed for DSH 0.2.2-rc.5 from the official manifest and the DSH 0.2.x
  client/host APIs observed in a more recent community fork.
- Host deletion preserves the original plugin's scope: session log directories,
  projection rows, and workspace references. This port does **not** implement
  the fork's optional attachment garbage collector or general orphan cleanup.
  Attached blobs that might be shared between sessions are not deleted.
- If DSH changes the layout of session persistence or service methods in a
  later prerelease, deletion may refuse to proceed. This is preferable to
  deleting an unknown path or proceeding while the agent is still active.
- DSH service availability varies by profile. The HTTP endpoint is registered
  only when the `webServer` service exists. The agent tool requires `tools`.
- The endpoint uses the same-origin browser request fence; as with the original
  plugin, local processes that can reach the server are not authenticated by
  this endpoint. Do not expose the development web server to untrusted networks.

## Credits

Original MIT project: [lsz-asd/dsh-plugin-session-delete](https://github.com/lsz-asd/dsh-plugin-session-delete).

DSH 0.2.x API reference: [SUKJG1052/DSH-Plugin-Session-Delete](https://github.com/SUKJG1052/DSH-Plugin-Session-Delete).

See [NOTICE.md](NOTICE.md) for the reconstruction and attribution details.
