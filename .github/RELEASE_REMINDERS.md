# Release reminders

Read this before cutting a minor or major release, act on every item in its section, and delete each item once it ships. Add an item whenever a change leaves something to finish in a later release, such as a deprecated alias to remove.

## Remove at next minor

- [ ] The deprecated pre-experimental SDK aliases from [#59072](https://github.com/anomalyco/opencode/pull/59072). Each old path is now `client.experimental.<same path>`, and each old type name is now `Experimental<name>`:
  - Methods: `client.session.{stats,import,export,skill,wait,log}`, `client.session.instructions.entry.{list,put,remove}`, `client.generate.text`, `client.voice.{models,session}`, `client.migration.v1.status`, `client.usage.limits`, `client.integration.wellknown.add`, `client.mcp.{add,remove,connect,disconnect}`, `client.mcp.client.token`, `client.file.{watch,unwatch}`, `client.config.update`, and `client.file.write` (Promise client only).
  - Types: the Input, Output and (Effect) Operation types of those methods, such as `SessionWaitInput`, plus the Effect `GenerateApi`, `VoiceApi`, `MigrationApi` and `UsageApi`, and the Promise `GenerateApi` in `packages/client/src/promise/api.ts`.
  - To remove: drop `aliases: true` from both `compile` calls in `packages/client/script/generate.ts` and run `bun run generate` in `packages/client`; delete `GenerateApi` from `packages/client/src/promise/api.ts`; delete `packages/client/test/deprecated-aliases.test.ts` and the alias entries in `packages/client/test/promise.test.ts`; drop the `Omit<IntegrationApi, "wellknown">` in `packages/plugin/src/{effect,promise}/integration.ts`.

## Remove at next major

No items yet.
