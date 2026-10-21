import { domain } from "./stage"

const GITHUB_APP_ID = new sst.Secret("GITHUB_APP_ID")
const GITHUB_APP_PRIVATE_KEY = new sst.Secret("GITHUB_APP_PRIVATE_KEY")
export const EMAILOCTOPUS_API_KEY = new sst.Secret("EMAILOCTOPUS_API_KEY")
const ADMIN_SECRET = new sst.Secret("ADMIN_SECRET")
const DISCORD_SUPPORT_BOT_TOKEN = new sst.Secret("DISCORD_SUPPORT_BOT_TOKEN")
const DISCORD_SUPPORT_CHANNEL_ID = new sst.Secret("DISCORD_SUPPORT_CHANNEL_ID")
const FEISHU_APP_ID = new sst.Secret("FEISHU_APP_ID")
const FEISHU_APP_SECRET = new sst.Secret("FEISHU_APP_SECRET")

export const api = new sst.cloudflare.Worker("Api", {
  domain: `api.${domain}`,
  handler: "packages/function/src/api.ts",
  url: true,
  link: [
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    ADMIN_SECRET,
    DISCORD_SUPPORT_BOT_TOKEN,
    DISCORD_SUPPORT_CHANNEL_ID,
    FEISHU_APP_ID,
    FEISHU_APP_SECRET,
  ],
  transform: {
    worker: (args) => {
      args.logpush = true
      // The v2 migration that deleted the SyncServer Durable Object class has been applied. Resending it fails every
      // deploy with a migration tag precondition error, so the worker no longer declares migrations.
    },
  },
})

new sst.cloudflare.x.Astro("Web", {
  domain: "docs." + domain,
  path: "packages/web",
  environment: {
    // For astro config
    SST_STAGE: $app.stage,
    VITE_API_URL: api.url.apply((url) => url!),
  },
})
