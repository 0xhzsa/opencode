import { expect, test } from "bun:test"
import NodeChildProcess from "node:child_process"
import { ProcessGuard } from "./process-guard.js"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The guard relies on POSIX process groups and sh.
test.skipIf(process.platform === "win32")("passes stdio and the exit status through", async () => {
  const wrapped = ProcessGuard.wrap("sh", ["-c", 'read line; echo "got $line"; exit 3'])
  const child = NodeChildProcess.spawn(wrapped.command, wrapped.args, {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    detached: true,
  })
  const output: Array<string> = []
  child.stdout.on("data", (chunk) => output.push(String(chunk)))
  const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)))
  child.stdin.end("hello\n")

  expect(await closed).toBe(3)
  expect(output.join("")).toBe("got hello\n")
})

test.skipIf(process.platform === "win32")(
  "kills the whole group when the parent is SIGKILLed",
  async () => {
    // The leader ignores stdin EOF and SIGTERM, and its descendant ignores stdin EOF.
    const parent = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import NodeChildProcess from "node:child_process";
    import { ProcessGuard } from ${JSON.stringify(new URL("./process-guard.ts", import.meta.url).pathname)};
    const wrapped = ProcessGuard.wrap("sh", ["-c", 'sleep 600 & echo $!; trap "" TERM; echo $$; while :; do sleep 1; done']);
    NodeChildProcess.spawn(wrapped.command, wrapped.args, { stdio: ["pipe", "inherit", "inherit", "pipe"], detached: true });
  `,
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const reader = parent.stdout.getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (text.split("\n").length < 3) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value)
    }
    const pids = text.trim().split("\n").map(Number)
    expect(pids).toHaveLength(2)

    parent.kill("SIGKILL")
    await parent.exited

    // SIGTERM ends the descendant at once; the leader ignores it until the SIGKILL two seconds later.
    const deadline = Date.now() + 10_000
    while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(50)
    const survivors = pids.filter(alive)
    survivors.forEach((pid) => process.kill(pid, "SIGKILL"))
    expect(survivors).toEqual([])
  },
  // The guard waits a real two seconds before escalating to SIGKILL.
  15_000,
)
