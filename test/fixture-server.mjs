#!/usr/bin/env node
/**
 * Тестовий полігон для прогонів лупів.
 *
 * Луп торкається зовнішнього світу рівно у двох місцях — `fetch` і
 * `api-request`. Щоб прогін щось доводив, обидва мають бути КЕРОВАНІ: не «якась
 * стрічка в інтернеті», а джерело, якому можна наказати впасти, віддати сміття
 * або мовчати до таймауту. Інакше червоний тест означає «хтось чужий лежить», а
 * не «луп поводиться неправильно».
 *
 *   node test/fixture-server.mjs [--port 19900]
 *
 * ДЖЕРЕЛА (GET)
 *   /feed/ok           RSS на 8 записів
 *   /feed/one          RSS на 1 запис — межа для fan-out
 *   /feed/empty        валідний RSS БЕЗ <item> — крок має впасти, не «успішно нічого»
 *   /feed/malformed    HTML замість RSS
 *   /feed/huge         RSS на 60 записів — перевірка обрізання
 *   /json/ok           {"rates":{"UAH":44.6},"ok":true}
 *   /json/low          {"rates":{"UAH":38.1}} — agent-gate має НЕ пропустити
 *   /json/notjson      text/plain, не JSON
 *   /material          матеріал для content-factory
 *   /slow              відповідає через 40с — довше за будь-який timeoutSec
 *   /status/:code      будь-який HTTP-код на замовлення
 *
 * ПРИЙМАЧІ (POST)
 *   /sink              201, тіло записується
 *   /sink/reject       500 — приймач живий, але відмовляє
 *   /sink/slow         відповідає через 40с
 *
 * ІНСПЕКЦІЯ
 *   GET  /_received    усе, що приймачі отримали
 *   POST /_reset       очистити
 */
import { createServer } from "node:http";

const PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--port") ?? 19900);
const received = [];

const item = (i) => `
<item><title>Fixture item ${i}</title><link>https://example.test/${i}</link>
  <description><![CDATA[Body of fixture item ${i}.]]></description>
  <pubDate>Fri, 01 Aug 2026 0${i % 10}:00:00 GMT</pubDate></item>`;

const rss = (n) =>
  `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Fixture feed</title>${
    Array.from({ length: n }, (_, i) => item(i + 1)).join("")
  }</channel></rss>`;

const ROUTES = {
  "/feed/ok": () => [200, "application/rss+xml", rss(8)],
  "/feed/one": () => [200, "application/rss+xml", rss(1)],
  /* Валідний RSS без записів: доводить, що порожня стрічка — це ПОМИЛКА кроку,
     а не тихий успіх над порожнечею. */
  "/feed/empty": () => [200, "application/rss+xml", `<?xml version="1.0"?>\n<rss version="2.0"><channel><title>Empty</title></channel></rss>`],
  "/feed/malformed": () => [200, "text/html", "<html><body><h1>Not a feed</h1></body></html>"],
  "/feed/huge": () => [200, "application/rss+xml", rss(60)],
  "/json/ok": () => [200, "application/json", JSON.stringify({ ok: true, rates: { UAH: 44.6, EUR: 0.92 } })],
  "/json/low": () => [200, "application/json", JSON.stringify({ ok: true, rates: { UAH: 38.1, EUR: 0.92 } })],
  "/json/notjson": () => [200, "text/plain", "definitely not json"],
  "/material": () => [200, "application/json", JSON.stringify({
    items: [
      { title: "InnoDB row locks explained", link: "https://example.test/a", note: "Why SELECT FOR UPDATE beats an optimistic claim." },
      { title: "Cron that lies about being alive", link: "https://example.test/b", note: "A tick that always returns 200 is a tick nobody notices is dead." },
    ],
  })],
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/_received") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(received));
  }
  if (req.method === "POST" && path === "/_reset") {
    received.length = 0;
    res.writeHead(200); return res.end("ok");
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");

    /* Повільні маршрути ніколи не відповідають у межах будь-якого розумного
       timeoutSec — так таймаут перевіряється, а не імітується sleep-ом у тесті. */
    if (path === "/slow" || path === "/sink/slow") {
      await new Promise((r) => setTimeout(r, 40_000));
      res.writeHead(200); return res.end("late");
    }

    const status = path.match(/^\/status\/(\d{3})$/);
    if (status) { res.writeHead(Number(status[1]), { "Content-Type": "text/plain" }); return res.end(`forced ${status[1]}`); }

    if (path.startsWith("/sink")) {
      received.push({ path, body, at: new Date().toISOString() });
      if (path === "/sink/reject") { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("receiver refused"); }
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ stored: true, n: received.length }));
    }

    const route = ROUTES[path];
    if (!route) { res.writeHead(404); return res.end("no such fixture"); }
    const [code, type, payload] = route();
    res.writeHead(code, { "Content-Type": type });
    res.end(payload);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fixtures on ${PORT}`));
