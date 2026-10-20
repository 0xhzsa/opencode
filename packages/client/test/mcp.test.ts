import { afterEach, describe, expect, test } from "bun:test"
import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client"
import type { ServerWebSocket } from "bun"
import { connectClientMcp, sessionID } from "../src/mcp"

type Peer = {
  readonly request: Request
  readonly socket: ServerWebSocket<{ id: number; request: Request }>
  readonly client: Client
  readonly closed: Promise<void>
}

const servers: Array<ReturnType<typeof serve>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

describe("connectClientMcp", () => {
  test("serves registered tools to the opencode server", async () => {
    const server = serve()
    const connection = connectClientMcp({
      url: server.url + "?ticket=t1",
      name: "tui",
      directory: "/repo",
      headers: { authorization: "Basic secret" },
      register(mcp) {
        mcp.registerTool("whoami", { description: "Return the calling session" }, (ctx) => ({
          content: [{ type: "text", text: sessionID(ctx) ?? "none" }],
        }))
      },
    })
    const peer = await server.next()

    const url = new URL(peer.request.url)
    expect(url.pathname).toBe("/api/experimental/client-mcp")
    expect(url.searchParams.get("name")).toBe("tui")
    expect(url.searchParams.get("ticket")).toBe("t1")
    expect(url.searchParams.get("location[directory]")).toBe("/repo")
    expect(peer.request.headers.get("authorization")).toBe("Basic secret")

    expect((await peer.client.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami"])
    expect(
      await peer.client.callTool({ name: "whoami", arguments: {}, _meta: { "ai.opencode/sessionID": "ses_1" } }),
    ).toMatchObject({ content: [{ type: "text", text: "ses_1" }] })
    expect(await peer.client.callTool({ name: "whoami", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "none" }],
    })

    await connection.close()
    await peer.closed
  })

  test("reconnects after the server drops the socket", async () => {
    const server = serve()
    const registered: string[] = []
    const connection = connectClientMcp({
      url: server.url,
      name: "tui",
      register(mcp) {
        registered.push("tools")
        mcp.registerTool("ping", {}, () => ({ content: [{ type: "text", text: "pong" }] }))
      },
    })
    const first = await server.next()
    expect((await first.client.listTools()).tools).toHaveLength(1)

    first.socket.close(1011, "internal")
    const second = await server.next()
    expect(await second.client.callTool({ name: "ping", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "pong" }],
    })
    expect(registered).toEqual(["tools", "tools"])

    await connection.close()
  })

  test("close stops reconnecting", async () => {
    const server = serve()
    const connection = connectClientMcp({ url: server.url, name: "tui", register() {} })
    const peer = await server.next()

    peer.socket.close(1011, "internal")
    await connection.close()
    await Bun.sleep(1_000)
    expect(server.connections()).toBe(1)
  })
})

function serve() {
  const waiting: Array<(peer: Peer) => void> = []
  const ready: Peer[] = []
  const transports = new Map<number, ReturnType<typeof socketTransport>>()
  const state = { connections: 0 }
  const server = Bun.serve<{ id: number; request: Request }>({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { id: ++state.connections, request } })) return
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        const transport = socketTransport(socket)
        transports.set(socket.data.id, transport)
        const client = new Client({ name: "opencode", version: "1.0.0" })
        const closed = new Promise<void>((resolve) => {
          client.onclose = resolve
        })
        void client.connect(transport).then(() => {
          const peer = { request: socket.data.request, socket, client, closed }
          const resolve = waiting.shift()
          if (resolve) return resolve(peer)
          ready.push(peer)
        })
      },
      message(socket, message) {
        transports.get(socket.data.id)?.deliver(String(message))
      },
      close(socket) {
        transports.get(socket.data.id)?.ended()
      },
    },
  })
  const result = {
    url: server.url.href,
    connections: () => state.connections,
    next: () =>
      new Promise<Peer>((resolve) => {
        const peer = ready.shift()
        if (peer) return resolve(peer)
        waiting.push(resolve)
      }),
    stop: (force: boolean) => server.stop(force),
  }
  servers.push(result)
  return result
}

function socketTransport(socket: ServerWebSocket<{ id: number; request: Request }>) {
  const state = { closed: false }
  const transport: Transport & { deliver(text: string): void; ended(): void } = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (state.closed) throw new Error("Not connected")
      socket.send(JSON.stringify(message))
    },
    async close() {
      socket.close(1000)
      transport.ended()
    },
    deliver(text) {
      transport.onmessage?.(JSON.parse(text))
    },
    ended() {
      if (state.closed) return
      state.closed = true
      transport.onclose?.()
    },
  }
  return transport
}
