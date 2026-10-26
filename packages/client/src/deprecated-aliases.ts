export * as DeprecatedAliases from "./deprecated-aliases.js"

// Pre-experimental paths of the methods #59072 moved under `client.experimental`. Removed in the next minor; see
// .github/RELEASE_REMINDERS.md.

type Shape = {
  readonly session: object
  readonly file: object
  readonly config: object
  readonly mcp: object
  readonly integration: object
  readonly experimental: {
    readonly session: {
      readonly stats: unknown
      readonly import: unknown
      readonly export: unknown
      readonly skill: unknown
      readonly wait: unknown
      readonly log: unknown
      readonly instructions: {
        readonly entry: { readonly list: unknown; readonly put: unknown; readonly remove: unknown }
      }
    }
    readonly generate: { readonly text: unknown }
    readonly voice: { readonly models: unknown; readonly session: unknown }
    readonly integration: { readonly wellknown: { readonly add: unknown } }
    readonly mcp: {
      readonly add: unknown
      readonly remove: unknown
      readonly connect: unknown
      readonly disconnect: unknown
      readonly client: { readonly token: unknown }
    }
    readonly file: { readonly watch: unknown; readonly unwatch: unknown }
    readonly migration: { readonly v1: { readonly status: unknown } }
    readonly usage: { readonly limits: unknown }
    readonly config: { readonly update: unknown }
  }
}

export function make<Client extends Shape>(raw: Client) {
  const experimental = raw.experimental
  return {
    session: {
      ...(raw.session as Client["session"]),
      /** @deprecated Use `client.experimental.session.stats`. Removed in the next minor. */
      stats: experimental.session.stats as Client["experimental"]["session"]["stats"],
      /** @deprecated Use `client.experimental.session.import`. Removed in the next minor. */
      import: experimental.session.import as Client["experimental"]["session"]["import"],
      /** @deprecated Use `client.experimental.session.export`. Removed in the next minor. */
      export: experimental.session.export as Client["experimental"]["session"]["export"],
      /** @deprecated Use `client.experimental.session.skill`. Removed in the next minor. */
      skill: experimental.session.skill as Client["experimental"]["session"]["skill"],
      /** @deprecated Use `client.experimental.session.wait`. Removed in the next minor. */
      wait: experimental.session.wait as Client["experimental"]["session"]["wait"],
      /** @deprecated Use `client.experimental.session.log`. Removed in the next minor. */
      log: experimental.session.log as Client["experimental"]["session"]["log"],
      /** @deprecated Use `client.experimental.session.instructions`. Removed in the next minor. */
      instructions: experimental.session.instructions as Client["experimental"]["session"]["instructions"],
    },
    /** @deprecated Use `client.experimental.generate`. Removed in the next minor. */
    generate: experimental.generate as Client["experimental"]["generate"],
    /** @deprecated Use `client.experimental.voice`. Removed in the next minor. */
    voice: experimental.voice as Client["experimental"]["voice"],
    /** @deprecated Use `client.experimental.migration`. Removed in the next minor. */
    migration: experimental.migration as Client["experimental"]["migration"],
    /** @deprecated Use `client.experimental.usage`. Removed in the next minor. */
    usage: experimental.usage as Client["experimental"]["usage"],
    integration: {
      ...(raw.integration as Client["integration"]),
      /** @deprecated Use `client.experimental.integration.wellknown`. Removed in the next minor. */
      wellknown: experimental.integration.wellknown as Client["experimental"]["integration"]["wellknown"],
    },
    mcp: {
      ...(raw.mcp as Client["mcp"]),
      /** @deprecated Use `client.experimental.mcp.add`. Removed in the next minor. */
      add: experimental.mcp.add as Client["experimental"]["mcp"]["add"],
      /** @deprecated Use `client.experimental.mcp.remove`. Removed in the next minor. */
      remove: experimental.mcp.remove as Client["experimental"]["mcp"]["remove"],
      /** @deprecated Use `client.experimental.mcp.connect`. Removed in the next minor. */
      connect: experimental.mcp.connect as Client["experimental"]["mcp"]["connect"],
      /** @deprecated Use `client.experimental.mcp.disconnect`. Removed in the next minor. */
      disconnect: experimental.mcp.disconnect as Client["experimental"]["mcp"]["disconnect"],
      /** @deprecated Use `client.experimental.mcp.client`. Removed in the next minor. */
      client: experimental.mcp.client as Client["experimental"]["mcp"]["client"],
    },
    file: {
      ...(raw.file as Client["file"]),
      /** @deprecated Use `client.experimental.file.watch`. Removed in the next minor. */
      watch: experimental.file.watch as Client["experimental"]["file"]["watch"],
      /** @deprecated Use `client.experimental.file.unwatch`. Removed in the next minor. */
      unwatch: experimental.file.unwatch as Client["experimental"]["file"]["unwatch"],
    },
    config: {
      ...(raw.config as Client["config"]),
      /** @deprecated Use `client.experimental.config.update`. Removed in the next minor. */
      update: experimental.config.update as Client["experimental"]["config"]["update"],
    },
  }
}
