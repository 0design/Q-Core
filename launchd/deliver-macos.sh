#!/bin/sh
# =============================================================================
# deliver-macos.sh — run a workflow on a schedule and put the result where a human
# will actually see it.
#
#   deliver-macos.sh /path/to/workflow.yaml
#
# WHY THIS EXISTS AND IS NOT A STEP KIND.
#
# The workflow engine has six step kinds and none of them writes to your Desktop,
# posts a Notification Center banner, or talks to a Mac-only task manager — on
# purpose. Those are properties of ONE machine, not of the workflow, and a manifest
# that hard-codes them stops being portable to the next person who runs it.
#
# So the split is: the workflow produces a payload; this wrapper delivers it here.
# Swap the wrapper and the same manifest delivers somewhere else.
#
# WHAT IT DOES
#   success → writes the digest to $QCORE_OUT_DIR/<date>.md
#           → posts a "ready" banner
#           → optionally adds it to Things (QF_THINGS=1)
#   failure → posts a banner WITH THE REASON, and exits non-zero.
#
# The failure banner is the point. A scheduled job that fails silently is worse
# than no job at all: you believe it ran. Before this wrapper existed, a broken
# 09:30 run left one line in a log file nobody opens.
#
# ENVIRONMENT (all optional except the workflow's own; sourced from ~/.qf/env)
#   QCORE_OUT_DIR   where the digest lands   (default ~/Documents/QF/digest)
#   QF_THINGS       1 = also add to Things   (default off)
#   QF_QUIET        1 = no banners           (default off)
# =============================================================================
set -u

WORKFLOW="${1:-}"
if [ -z "$WORKFLOW" ]; then
  echo "usage: deliver-macos.sh /path/to/workflow.yaml" >&2
  exit 64
fi

HERE=$(cd "$(dirname "$0")" && pwd)
QCORE="$HERE/../bin/q-core.mjs"
NODE="${QF_NODE:-$(command -v node || echo /usr/local/bin/node)}"

# Secrets live in one file, not in the plist: a plist is world-readable.
#
# QF_NO_ENV_FILE=1 skips it. Not a nicety: sourcing this file UNCONDITIONALLY
# overwrites whatever the caller exported, so an attempt to test the failure
# path by pointing the workflow at a dead URL silently ran the healthy workflow again
# and reported success. A test that cannot make the thing fail proves nothing.
[ "${QF_NO_ENV_FILE:-0}" = "1" ] || { [ -f "$HOME/.qf/env" ] && . "$HOME/.qf/env"; }

OUT_DIR="${QCORE_OUT_DIR:-$HOME/Documents/QF/digest}"
DAY=$(date +%Y-%m-%d)
DEST="$OUT_DIR/$DAY.md"
mkdir -p "$OUT_DIR" || exit 1

notify() {
  # $1 title · $2 body. Never fatal: a missing banner must not fail the run.
  [ "${QF_QUIET:-0}" = "1" ] && return 0
  /usr/bin/osascript -e "display notification $(printf '%s' "$2" | sed 's/"/\\"/g; s/^/"/; s/$/"/') with title \"$1\"" 2>/dev/null || true
}

RUN_JSON=$("$NODE" "$QCORE" run "$WORKFLOW" --json --quiet 2>/tmp/q-core-deliver.err)
CODE=$?

# One node call does the reading: the run object is JSON, and parsing JSON with
# sed is how you get a digest that silently loses every line containing a quote.
#
# STATUS IS THE FIRST LINE, BODY IS EVERYTHING AFTER — and that shape is load-
# bearing. The first version used a tab separator and `cut -f1`, which splits
# PER LINE: every line of the digest without a tab came back as part of the
# status, the `case` matched nothing, and a run that had just produced a perfect
# digest was announced as failed. Caught by running it, not by reading it.
SUMMARY=$("$NODE" -e '
  const fs = require("fs");
  let run; try { run = JSON.parse(process.argv[1]); } catch { process.exit(9); }
  if (run.status !== "success") {
    process.stdout.write("FAIL\n" + (run.reason || run.summary || "no reason recorded"));
    process.exit(0);
  }
  /* The payload is wherever the last delivering step put it. With no receiver
     configured that is the file sink; with one, the workflow already delivered and
     there is nothing for us to write. */
  const sink = [...run.steps].reverse().find((s) => s.output && s.output.sink === "file");
  if (!sink) { process.stdout.write("SENT\nthe workflow delivered it itself"); process.exit(0); }
  let text = "";
  try {
    const raw = fs.readFileSync(sink.output.file, "utf8");
    try { const o = JSON.parse(raw); text = o.text ?? o.message ?? raw; } catch { text = raw; }
  } catch (e) { process.stdout.write("FAIL\nsink file unreadable: " + e.message); process.exit(0); }
  process.stdout.write("OK\n" + text);
' "$RUN_JSON" 2>/dev/null)

STATUS=$(printf '%s\n' "$SUMMARY" | sed -n 1p)
BODY=$(printf '%s\n' "$SUMMARY" | sed 1d)
NAME=$(basename "$WORKFLOW" .yaml)

case "$STATUS" in
  OK)
    {
      printf '# %s — %s\n\n' "$NAME" "$DAY"
      printf '%s\n' "$BODY"
    } > "$DEST"
    notify "$NAME" "Ready · $(basename "$DEST")"

    if [ "${QF_THINGS:-0}" = "1" ]; then
      # Things takes the whole digest as the note, so the task is self-contained
      # — you read it in the inbox without opening the file.
      URL=$("$NODE" -e '
        const t = process.argv[1], n = process.argv[2], f = process.argv[3];
        const e = encodeURIComponent;
        process.stdout.write(`things:///add?title=${e(t)}&notes=${e(n + "\n\n" + f)}`);
      ' "$NAME — $DAY" "$BODY" "$DEST")
      /usr/bin/open "$URL" 2>/dev/null || true
    fi
    exit 0
    ;;
  SENT)
    notify "$NAME" "Delivered by the workflow itself."
    exit 0
    ;;
  *)
    REASON=${BODY:-$(head -c 200 /tmp/q-core-deliver.err 2>/dev/null)}
    notify "$NAME — FAILED" "${REASON:-exit $CODE, no reason recorded}"
    printf '%s failed: %s\n' "$NAME" "${REASON:-exit $CODE}" >&2
    exit "${CODE:-1}"
    ;;
esac
