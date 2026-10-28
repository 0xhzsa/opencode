import { describe, expect, test } from "bun:test";
import {
  BrowserObserver,
  CdpSession,
  COMPOSER_EXPRESSION,
  findChatTargets,
  isChatUrl,
} from "../src/observe/cdp";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("isChatUrl", () => {
  test("accepts known chat hosts", () => {
    expect(isChatUrl("https://claude.ai/chat/abc")).toBe(true);
    expect(isChatUrl("https://chatgpt.com/c/123")).toBe(true);
    expect(isChatUrl("https://gemini.google.com/app")).toBe(true);
    expect(isChatUrl("https://www.perplexity.ai/search")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isChatUrl("https://example.com")).toBe(false);
    expect(isChatUrl("chrome://newtab")).toBe(false);
    expect(isChatUrl("file:///C:/secret.txt")).toBe(false);
    expect(isChatUrl("not a url")).toBe(false);
  });
});

describe("findChatTargets", () => {
  test("keeps only chat pages with a debugger URL", async () => {
    let port = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/json/list") return new Response("no", { status: 404 });
        return Response.json([
          {
            id: "1",
            type: "page",
            title: "Claude",
            url: "https://claude.ai/chat/x",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`,
          },
          {
            id: "2",
            type: "page",
            title: "Example",
            url: "https://example.com",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`,
          },
          {
            id: "3",
            type: "service_worker",
            title: "Claude worker",
            url: "https://claude.ai/sw.js",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`,
          },
        ]);
      },
    });
    port = server.port;

    const found = await findChatTargets(server.port);
    expect(found.length).toBe(1);
    expect(found[0].id).toBe("1");
    server.stop(true);
  });

  test("surfaces a helpful error when CDP is not running", async () => {
    await expect(findChatTargets(1)).rejects.toThrow();
  });
});

describe("CdpSession", () => {
  test("evaluates an expression and returns the value", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.method === "Runtime.evaluate") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    type: "object",
                    value: { text: "Add a login endpoint", host: "claude.ai", title: "Claude" },
                  },
                },
              })
            );
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        },
      },
    });

    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/`);
    const value = (await session.evaluate(COMPOSER_EXPRESSION)) as {
      text: string;
      host: string;
    };
    expect(value.text).toBe("Add a login endpoint");
    expect(value.host).toBe("claude.ai");

    session.close();
    server.stop(true);
  });

  test("rejects when the page throws", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: { exceptionDetails: { text: "ReferenceError: x is not defined" } },
            })
          );
        },
      },
    });

    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/`);
    await expect(session.evaluate("x")).rejects.toThrow(/CDP evaluate failed/);

    session.close();
    server.stop(true);
  });
});

describe("BrowserObserver", () => {
  test("emits the composer text when the composer clears", async () => {
    let composer = "Add a login endpoint that checks the password";
    let port = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/json/list") {
          return Response.json([
            {
              id: "1",
              type: "page",
              title: "Claude",
              url: "https://claude.ai/chat/x",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`,
            },
          ]);
        }
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.method === "Runtime.evaluate") {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: {
                    type: "object",
                    value: { text: composer, host: "claude.ai", title: "Claude" },
                  },
                },
              })
            );
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        },
      },
    });
    port = server.port;

    const got: { text: string; host: string }[] = [];
    const observer = new BrowserObserver({
      port: server.port,
      pollMs: 25,
      refreshMs: 1000,
      onPrompt: (p) => got.push(p),
    });

    observer.start();
    await sleep(100);
    composer = "";
    await sleep(350);
    observer.stop();
    server.stop(true);

    expect(got.length).toBe(1);
    expect(got[0].text).toContain("login endpoint");
    expect(got[0].host).toBe("claude.ai");
  });
});
