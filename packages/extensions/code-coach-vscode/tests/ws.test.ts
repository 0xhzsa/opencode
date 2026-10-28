import { describe, expect, test } from "bun:test";
import { MiniWebSocket } from "../src/observe/ws";

describe("MiniWebSocket", () => {
  test("handshakes and exchanges text frames", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(ws, message) {
          ws.send(`echo:${String(message)}`);
        },
      },
    });

    const ws = await MiniWebSocket.connect(`ws://127.0.0.1:${server.port}/`);
    const received = new Promise<string>((resolve) => {
      ws.onmessage = resolve;
    });

    ws.send("hello");
    expect(await received).toBe("echo:hello");

    ws.close();
    server.stop(true);
  });

  test("rejects a response that is not a 101 upgrade", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not a websocket", { status: 200 });
      },
    });

    await expect(MiniWebSocket.connect(`ws://127.0.0.1:${server.port}/`)).rejects.toThrow(
      /upgrade failed/
    );
    server.stop(true);
  });

  test("rejects non-ws schemes", async () => {
    await expect(MiniWebSocket.connect("http://127.0.0.1:1/")).rejects.toThrow(/ws:\/\//);
  });
});
