/* A real pseudo-terminal stands in for the person in automated checks: it reads the
   one-time code from the terminal and types it back (or types `answer`). Tests and
   package checks only; the instructions forbid an agent from doing this. */
import { spawnSync } from "node:child_process";

const PTY = `
import json, os, pty, re, select, sys
argv, env, answer = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, env)
buf, sent = b"", False
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r: break
    try: data = os.read(fd, 4096)
    except OSError: break
    if not data: break
    buf += data
    m = re.search(rb"type the code ([A-Z0-9]{6})", buf)
    if m and not sent and buf.rstrip().endswith(b"code:"):
        os.write(fd, (m.group(1).decode() if answer == "CODE" else answer).encode() + b"\\n")
        sent = True
_, status = os.waitpid(pid, 0)
print(json.dumps({"exit": os.waitstatus_to_exitcode(status), "out": buf.decode(errors="replace")}))
`;

export const ptyAvailable = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;

/** Run argv at a pseudo-terminal; answer "CODE" types the shown code. Returns {exit, out}. */
export function atTerminal(argv, { env, cwd, answer = "CODE" }) {
  const r = spawnSync("python3", ["-c", PTY, JSON.stringify(argv), JSON.stringify(env), answer], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pseudo-terminal failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
