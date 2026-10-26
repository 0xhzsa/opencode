# Release reminders

Read this before cutting a minor or major release, act on every item in its section, and delete each item once it ships. Add an item whenever a change leaves something to finish in a later release, such as a deprecated alias to remove.

## Next minor

- [ ] Remove the deprecated pre-experimental SDK and plugin aliases from [#59072](https://github.com/anomalyco/opencode/pull/59072):
  - SDK methods (`packages/client/src/deprecated-aliases.ts`, plus `file.write` in `packages/client/src/promise/client.ts`), each now at `client.experimental.<same path>`:
    - `client.session.{stats,import,export,skill,wait,log}`
    - `client.session.instructions.entry.{list,put,remove}`
    - `client.generate.text`
    - `client.voice.{models,session}`
    - `client.migration.v1.status`
    - `client.usage.limits`
    - `client.integration.wellknown.add`
    - `client.mcp.{add,remove,connect,disconnect}` and `client.mcp.client.token`
    - `client.file.{watch,unwatch}` and, in the Promise client only, `client.file.write`
    - `client.config.update`
  - SDK types renamed with an `Experimental` prefix (`packages/client/src/promise/deprecated.ts`, `packages/client/src/effect/deprecated.ts`, and `GenerateApi` in `packages/client/src/promise/api.ts`), for example `SessionWaitInput` → `ExperimentalSessionWaitInput`.
  - Plugin `Context` paths (`packages/plugin/src/{effect,promise}/{plugin,session}.ts`, wired in `packages/core/src/plugin/host.ts`, `packages/plugin/src/promise/adapter.ts` and `packages/core/test/plugin/host.ts`), each now under `ctx.experimental`:
    - `ctx.generate`
    - `ctx.session.wait`
    - `ctx.session.instructions`
  - Then drop the `Omit<IntegrationApi, "wellknown">` in `packages/plugin/src/{effect,promise}/integration.ts` and the alias expectations in `packages/client/test/{promise,effect}.test.ts` and `packages/core/test/plugin/experimental-namespace.test.ts`.

## Next major

No items yet.
