#!/usr/bin/env node
/**
 * Матриця прогонів: кожен луп × кожен сценарій, із записом того, що СПРАВДІ
 * сталося.
 *
 *   node test/fixture-server.mjs &
 *   node test/run-matrix.mjs > ../../../context/LOG-loop-matrix.md
 *
 * Сценарій — це набір змінних оточення, які перенаводять луп на інший фікстур:
 * джерело, що падає, приймач, що відмовляє, відсутній ключ моделі. Маніфести
 * при цьому НЕ правляться — і в цьому суть: те, як луп поводиться при відмові,
 * має бути властивістю лупа, а не тестового форку.
 *
 * КОЖЕН РЯДОК ЛОГУ — факт: очікування, реальний код виходу, реальний статус,
 * реальна причина. Тест, який не називає, чого чекав, нічого не доводить.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const QL = join(PKG, "bin", "qloop.mjs");
const F = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 19900}`;
const KEY = process.env.OPENROUTER_API_KEY ?? "";

/** Сценарії. `expect` — те, чого ми чекаємо ДО прогону, а не після. */
const SCENARIOS = [
  { id: "happy",       label: "усе здорове",              env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "success" },
  { id: "src-500",     label: "джерело віддає 500",       env: { QLOOP_SOURCE_URL: `${F}/status/500`,     QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "src-empty",   label: "стрічка без записів",      env: { QLOOP_SOURCE_URL: `${F}/feed/empty`,     QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "src-garbage", label: "HTML замість RSS",         env: { QLOOP_SOURCE_URL: `${F}/feed/malformed`, QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "sink-500",    label: "приймач відмовляє",        env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink/reject` }, expect: "failed" },
  { id: "no-key",      label: "ключа моделі немає",       env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, noKey: true, expect: "depends" },
  { id: "dry",         label: "--dry-run",                env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, dry: true, expect: "success" },
];

/** Джерела, які лупу потрібні в іншому форматі, ніж дефолт сценарію. */
const SOURCE_OVERRIDE = {
  "price-watch":   { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "strict-gate":   { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "webhook-relay": { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "content-factory": { happy: `${F}/material`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/material`, "no-key": `${F}/material`, dry: `${F}/material` },
  "release-watch": { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "brand-mentions": { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "content-feed":  { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "feed-fanout":   { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "wide-fanout":   { happy: `${F}/feed/huge`, "sink-500": `${F}/feed/huge`, "no-key": `${F}/feed/huge`, dry: `${F}/feed/huge` },
};

const loops = readdirSync(join(PKG, "loops")).filter((f) => f.endsWith(".yaml")).sort();

async function reset() { await fetch(`${F}/_reset`, { method: "POST" }).catch(() => {}); }
async function receivedCount() {
  /* Тільки успішно ПРИЙНЯТЕ. `/sink/reject` записує тіло й віддає 500 — це
     спроба доставки, а не доставка, і плутати їх означало б бачити витік там,
     де луп чесно впав на відмові приймача. */
  try {
    const all = await (await fetch(`${F}/_received`)).json();
    return all.filter((r) => r.path === "/sink").length;
  } catch { return -1; }
}

function runOne(loopFile, sc) {
  const id = loopFile.replace(/\.yaml$/, "");
  const env = { ...process.env, ...sc.env, QF_NO_UPDATE_CHECK: "1" };
  if (SOURCE_OVERRIDE[id]?.[sc.id]) env.QLOOP_SOURCE_URL = SOURCE_OVERRIDE[id][sc.id];
  /* content-feed і брати ходять у Telegram через свої змінні — у полігоні їх
     немає, тож приймач підміняється тим самим вебхуком. */
  env.TELEGRAM_BOT_TOKEN = ""; env.TELEGRAM_CHAT_ID = "";
  env.OPENROUTER_API_KEY = sc.noKey ? "" : KEY;
  if (!env.OPENROUTER_API_KEY) delete env.OPENROUTER_API_KEY;

  const args = ["run", join(PKG, "loops", loopFile), "--json", "--quiet"];
  if (sc.dry) args.push("--dry-run");
  const r = spawnSync("node", [QL, ...args], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

  let run = null;
  try { run = JSON.parse(r.stdout.trim()); } catch {}
  return {
    exit: r.status,
    status: run?.status ?? "(no json)",
    summary: (run?.summary ?? r.stderr.trim().split("\n")[0] ?? "").slice(0, 150),
    cost: run?.costUsd ?? 0,
    steps: run?.steps?.length ?? 0,
    done: run?.steps?.filter((s) => s.status === "success" || s.status === "planned").length ?? 0,
  };
}

/* ── прогін ───────────────────────────────────────────────────────────────── */

console.log(`# Матриця прогонів лупів\n`);
console.log(`> Полігон: \`test/fixture-server.mjs\` на ${F}. Маніфести не правились —`);
console.log(`> сценарій міняє лише змінні оточення, тобто поведінку при відмові`);
console.log(`> демонструє сам луп, а не тестовий форк.\n`);
console.log(`Лупів: **${loops.length}** · сценаріїв: **${SCENARIOS.length}** · прогонів: **${loops.length * SCENARIOS.length}**\n`);

const rows = [];
for (const f of loops) {
  const id = f.replace(/\.yaml$/, "");
  console.log(`\n## ${id}\n`);
  console.log(`| сценарій | чекали | exit | статус | кроків | $ | що сказав ран |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const sc of SCENARIOS) {
    await reset();
    const before = await receivedCount();
    const out = runOne(f, sc);
    const after = await receivedCount();
    const delivered = after - before;
    rows.push({ loop: id, sc: sc.id, ...out, delivered });
    console.log(
      `| ${sc.label} | ${sc.expect} | \`${out.exit}\` | **${out.status}** | ${out.done}/${out.steps} | ${out.cost ? "$" + Number(out.cost).toFixed(4) : "—"} | ${out.summary.replace(/\|/g, "\\|")} |`,
    );
  }
}

/* ── зведення ─────────────────────────────────────────────────────────────── */
console.log(`\n---\n\n## Зведення\n`);
const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log(`Прогонів: **${rows.length}**\n`);
console.log(`| статус | скільки |`);
console.log(`|---|---|`);
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${v} |`);

const spend = rows.reduce((a, r) => a + Number(r.cost || 0), 0);
console.log(`\nВитрачено на всю матрицю: **$${spend.toFixed(4)}**\n`);

/* Найважливіша перевірка: жоден ран, що НЕ дійшов до кінця, не мав нічого
   надіслати. Це та властивість, заради якої гейти й бюджет узагалі існують. */
const leaked = rows.filter((r) => r.status !== "success" && r.delivered > 0);
console.log(`\n### Чи слав щось ран, який не дійшов до кінця\n`);
console.log(leaked.length
  ? leaked.map((r) => `- ⚠️ **${r.loop} / ${r.sc}** — статус \`${r.status}\`, а приймач отримав ${r.delivered}`).join("\n")
  : `Жодного разу. ${rows.filter((r) => r.status !== "success").length} невдалих ранів — нуль доставлених запитів.`);
