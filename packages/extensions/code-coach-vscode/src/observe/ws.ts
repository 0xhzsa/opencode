/*
 * ws.ts - a minimal RFC 6455 WebSocket client (text frames only).
 *
 * Why not the `ws` package: the extension host runs Node 20, which has no
 * global WebSocket, and adding a runtime dependency to a VS Code extension
 * means shipping node_modules. This client is ~150 lines, has no deps, and is
 * enough for the Chrome DevTools Protocol, which is the only consumer.
 */

import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export class MiniWebSocket {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private fragments: string[] = [];
  private closed = false;

  onmessage: (text: string) => void = () => {};
  onclose: () => void = () => {};

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  static connect(url: string, timeoutMs = 5000): Promise<MiniWebSocket> {
    const u = new URL(url);
    if (u.protocol !== "ws:") {
      return Promise.reject(new Error("MiniWebSocket only supports ws://"));
    }
    const host = u.hostname;
    const port = Number(u.port || "80");
    const path = (u.pathname || "/") + (u.search || "");
    const key = randomBytes(16).toString("base64");

    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const ws = new MiniWebSocket(socket);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("websocket handshake timed out"));
      }, timeoutMs);

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      socket.on("close", () => {
        ws.closed = true;
        ws.onclose();
      });

      socket.on("data", (chunk: Buffer) => {
        ws.buffer = Buffer.concat([ws.buffer, chunk]);

        if (!ws.handshakeDone) {
          const end = ws.buffer.indexOf("\r\n\r\n");
          if (end === -1) return;
          const head = ws.buffer.subarray(0, end).toString("latin1");
          ws.buffer = ws.buffer.subarray(end + 4);
          if (!/^HTTP\/1\.1 101/.test(head)) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(`websocket upgrade failed: ${head.split("\r\n")[0] ?? "unknown"}`));
            return;
          }
          ws.handshakeDone = true;
          settled = true;
          clearTimeout(timer);
          resolve(ws);
        }

        ws.drain();
      });

      socket.on("connect", () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n` +
            `\r\n`
        );
      });
    });
  }

  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return;

      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const hi = this.buffer.readUInt32BE(2);
        const lo = this.buffer.readUInt32BE(6);
        len = hi * 0x100000000 + lo;
        offset = 10;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      this.buffer = this.buffer.subarray(offset + len);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload.toString("utf8"));
        if (fin) {
          const text = this.fragments.join("");
          this.fragments = [];
          this.onmessage(text);
        }
      }
    }
  }

  private sendFrame(payload: Buffer, opcode: number): void {
    if (this.socket.destroyed) return;
    const mask = randomBytes(4);
    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }

    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text: string): void {
    if (this.closed) return;
    this.sendFrame(Buffer.from(text, "utf8"), 0x1);
  }

  close(): void {
    if (this.closed) return;
    this.sendFrame(Buffer.alloc(0), 0x8);
    this.closed = true;
    this.socket.end();
  }
}
