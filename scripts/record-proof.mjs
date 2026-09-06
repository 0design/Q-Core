#!/usr/bin/env node
/**
 * Записати ДОКАЗ прогону лупа в `examples/`, звідки його бере каталог.
 *
 *   node scripts/record-proof.mjs <loop-id> [runId]
 *
 * Каталог показує ціну лише тоді, коли вона ВИМІРЯНА (`src/catalog.mjs`).
 * Джерело цього виміру — справжній записаний ран, а не оцінка. Цей скрипт бере
 * останній успішний ран лупа з `loops/.qf/runs/` і кладе поруч дві речі:
 *
 *   examples/<id>.run.json   слід: кроки, статуси, токени, вартість
 *   examples/<id>.txt        те, що луп справді віддав
 *
 * САНІТАРІЯ ОБОВ'ЯЗКОВА. Ран несе URL-и, тіла запитів і виходи моделі — усе це
 * їде в публічний репозиторій. Тому: URL зрізається до origin, а все, що схоже
 * на токен, замінюється. Регулярка не знає твоїх даних краще за тебе — переглянь
 * файл перед комітом.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const [id, wantRun] = process.argv.slice(2);
if (!id) { console.error("usage: record-proof.mjs <loop-id> [runId]"); process.exit(64); }

const runsDir = join(PKG, "loops", ".qf", "runs");
if (!existsSync(runsDir)) { console.error(`no runs at ${runsDir} — run the loop first`); process.exit(1); }

const runs = readdirSync(runsDir).filter((f) => f.endsWith(".json"))
  .map((f) => { try { return JSON.parse(readFileSync(join(runsDir, f), "utf8")); } catch { return null; } })
  .filter((r) => r && r.loopId === id && (!wantRun || r.runId === wantRun))
  .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

/* Доказ ставиться лише з УСПІШНОГО рану. Записати провал як «ось що воно
   робить» означало б показувати в каталозі не те, що обіцяно. */
const run = runs.find((r) => r.status === "success") ?? null;
if (!run) { console.error(`no successful run for "${id}"`); process.exit(1); }

/** URL → origin. Токеноподібне → мітка. Ран їде в публічний репозиторій. */
const clean = (s) => String(s)
  .replace(/https?:\/\/[^\s"']+/g, (u) => { try { return new URL(u).origin + "/…"; } catch { return "…"; } })
  .replace(/sk-or-[A-Za-z0-9._-]{8,}/g, "sk-or-…")
  .replace(/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "…:…");

const trace = {
  runId: run.runId, loopId: run.loopId, status: run.status, summary: clean(run.summary),
  startedAt: run.startedAt, costUsd: run.costUsd, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
  steps: run.steps.map((s) => ({
    kind: s.kind, name: s.name, status: s.status,
    itemIndex: s.itemIndex ?? null, costUsd: s.costUsd,
  })),
};

/* Текст доказу — те, що луп ВІДДАВ. Для api-request це тіло, яке доїхало; для
   моделі — її вихід. Якщо нічого текстового немає, файл не створюємо: порожній
   доказ гірший за його відсутність, бо каталог тоді покаже пусту панель. */
const last = [...run.steps].reverse().find((s) => s.output && (s.output.text || s.output.response || s.output.markdown));
const text = last ? clean(last.output.text ?? last.output.markdown ?? last.output.response) : "";

mkdirSync(join(PKG, "examples"), { recursive: true });
writeFileSync(join(PKG, "examples", `${id}.run.json`), JSON.stringify(trace, null, 2) + "\n");
if (text.trim()) writeFileSync(join(PKG, "examples", `${id}.txt`), text.trim() + "\n");

console.log(`${id}: ${trace.steps.length} кроків · $${Number(run.costUsd).toFixed(4)}${text.trim() ? " · текст записано" : " · текстового виходу немає"}`);
