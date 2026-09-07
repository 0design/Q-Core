import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runContentRequest } from "../src/content-runner.mjs";
for (const kind of ["claude", "codex"])
  test(`${kind}: content sources -> CLI fixture -> check -> approval -> real local receiver; three deliveries, dedup and failure`, async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "qloops-content-http-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    let sends = 0,
      fail = false;
    const keys = new Set();
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        res.end("Synthetic source " + req.url);
        return;
      }
      sends++;
      const key = req.headers["idempotency-key"];
      assert.ok(key);
      assert.equal(keys.has(key), false);
      keys.add(key);
      if (fail) {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `receipt-${sends}`, delivered: true }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => new Promise((r) => server.close(r)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = {
      protocolVersion: "qf.content-request/v1",
      workspace,
      requestId: "content-http",
      allowedOrigins: [origin],
      deadlineMs: 3000,
      profile: { tone: "fixture" },
      provider: {
        kind,
        model: "fixture",
        executable: resolve(`test/fixtures/${kind}.mjs`),
        payerScope: "local-cli",
      },
      receiver: { kind: "webhook", url: origin + "/receiver" },
    };
    for (let i = 1; i <= 3; i++) {
      const r = {
        ...base,
        sources: [{ id: String(i), url: origin + "/source/" + i }],
      };
      const first = await runContentRequest(r);
      assert.equal(first.status, "needs_human");
      const done = await runContentRequest({
        ...r,
        approval: { hash: first.nextAction.hash, decision: "approve" },
      });
      assert.equal(done.status, "success");
      assert.equal(
        (await runContentRequest(r)).nextAction.type,
        "no_new_sources",
      );
    }
    assert.equal(sends, 3);
    fail = true;
    const r = {
      ...base,
      sources: [{ id: "fail", url: origin + "/source/fail" }],
    };
    const first = await runContentRequest(r);
    const approved = {
      ...r,
      approval: { hash: first.nextAction.hash, decision: "approve" },
    };
    assert.equal((await runContentRequest(approved)).status, "needs_human");
    assert.equal((await runContentRequest(approved)).status, "needs_human");
    assert.equal(sends, 4);
  });
