export * as ProcessGuard from "./process-guard.js"

/**
 * The command runs in the background of a POSIX `sh`, which must be spawned as the leader of its own
 * process group. A watcher subshell blocks reading fd 3; the kernel closes the parent's end when the
 * parent exits for any reason, including SIGKILL, and the watcher then sends SIGTERM to the whole
 * group, followed by SIGKILL two seconds later. `kill 0` targets the watcher's own group, which
 * exists for as long as the watcher does, so a reused PID can never be hit.
 *
 * An async command's stdin is /dev/null unless redirected explicitly, so stdin is passed through fd 4.
 * When the command exits on its own, the watcher is stopped and its exit status (128 + n for a
 * signal) becomes the shell's.
 */
const SCRIPT = `exec 4<&0 0</dev/null
(read _ <&3; trap '' TERM; kill -TERM 0; sleep 2; kill -KILL 0) >/dev/null 2>&1 4<&- &
guard=$!
"$@" 3<&- <&4 4<&- &
child=$!
exec 3<&- 4<&-
wait "$child"
code=$?
kill "$guard" 2>/dev/null
exit "$code"`

/**
 * Wraps a command so its whole process group dies with the parent, even when the parent is
 * SIGKILLed. Spawn the result detached, with fd 3 as a pipe that the parent holds open and never
 * writes. POSIX only.
 */
export function wrap(command: string, args: ReadonlyArray<string>) {
  return { command: "/bin/sh", args: ["-c", SCRIPT, command, command, ...args] }
}
