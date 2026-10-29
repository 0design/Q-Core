Виправлення раунду 2 готове: після reject пропускаються прямі й транзитивні споживачі відхилених/пропущених outputs; незалежні кроки виконуються. **Повний набір — 1779/1779 PASS; незалежне рев’ю реалізації — PASS.**

Повністю прочитано Air-рев’ю `codex-runs/air-reviews-1029/qcore/answer.md`. База — `b1d2792b68608e3adfb17f6923a03f8da122547f`. Підстава з поточного доручення: D-0467 — «ні» пропускає свою гілку; workflows мають бути надійними автоматизаціями.

| Зауваження рецензента | Рішення й доказ |
| --- | --- |
| **P1: структурний сусід може залежати від пропущеного output** | Закрито. Перед dispatch перевіряються посилання на outputs у межах invocation: rejected/skipped producer → skipped споживач → транзитивний пропуск. Тест **outer → inner(review, blocked) → outer-next**, де outer-next читає `steps.blocked.output`, перевіряє також транзитивного споживача в сусідній гілці та єдиний незалежний HTTP-запит. |
| **P2: helper ловив TypeError до resumeRun** | Закрито. Аргументи зберігаються до рішення; тест напряму викликає `resumeRun(saved, originalDecision)` на завершеному прогоні. Перевіряє точні `STALE_APPROVAL` / `Approval does not match the current persisted run.`, незмінний persisted snapshot і відсутність повторного HTTP. Signed terminal replay теж перевіряє конкретну помилку. |
| Прямі/транзитивні залежності; нерозгорнуті гілки | Закрито тестами: outputs gate, display names, оголошені нащадки skipped control, JSON-escaped body/headers/workflow-call inputs. Останній пропущений producer повторного item блокує використання старого успішного output. |
| Незалежність і правильний resolver | Негативні приклади PASS: буквальні JSON-ключі, metadata, отримані з HTTP шаблоноподібні дані, пріоритет ID/display-name, неактивні fallback/formatting поля. Підставлені дані не скануються повторно як код. |
| Підпис, hash, Touch ID, approve | Production-переходи й перевірки не змінено. Signed-тести перевіряють невірний підпис, subject hash, прострочений challenge і змінений snapshot. Новий синтетичний approve наступного незалежного gate після reject виконує тільки дозволений локальний HTTP. Справжні approve/Touch ID не виконувалися. |
| Старе підписане рішення на наступному gate | Закрито: прямий replay старого signed reject, коли наступний item вже чекає, дає `STALE_APPROVAL`; новий gate і snapshot незмінні. |
| Збереження reject до ефекту; відновлення | Закрито ін’єкцією збою відразу після фактичного `store.save(reject)`, до HTTP. Reload + drive виконує лише незалежний запит; повтор завершеного прогону його не повторює. Це виняток після save, не OS kill. |
| Старі failed snapshots | Закрито на двох синтетичних fixtures зі старою формою: human reject і технічна помилка. Load/drive залишають їх термінальними й незмінними; resume відмовляє; HTTP немає. Автоміграції чи перезапуску немає. |
| Багаторівневі workflow-call; вкладені each/fan-out | Закрито: leaf → middle → root передає rejection через обидва return; продовження пропускаються. each → each та each → fan-out з reject/approve різних items зберігають незалежні items і зовнішні продовження. |
| Окремі процеси reject/reject, reject/approve, resume/drive | Розширення відхилено для цього мінімального виправлення: конкретної гонки рецензент не встановив; locking не змінюється. Наявний `withRunLock` серіалізує рішення, але окремий driveRun ним не охоплений. Багатопроцесна коректність тут **не доведена**. |
| Аварія після HTTP до запису результату | Розширення відхилено: це окремий контракт відновлення зовнішніх ефектів/idempotency. Нового доказу exactly-once у цьому вікні немає. |
| Таймаут самого gate | Семантика незмінна; строк signed challenge перевірено негативним тестом, наявні timeout-тести входять до повного suite. Новий сценарій «reject → наступний gate → timeout» не додано: він не потрібен для перевірки поширення залежностей і не оголошується доведеним. |

Обрано **runtime-поширення пропуску**: заборона залежностей між гілками відкинула б коректні workflows, які мають працювати після approve. Окремо валідація явно відхиляє `needs/data/from/out` на кроці або в config: у поточному форматі ці декларації не мають виконуваної семантики й раніше ігнорувалися. Це відмова до запуску, не удавана підтримка needs. Підтримувані зв’язки даних задаються посиланнями на outputs у відповідних config-полях.

Production-diff обмежений `src/run.mjs` і `src/manifest.mjs`. Тести: `test/approval-branch-rejection.test.mjs`, `test/approval-rejection-recovery.test.mjs`.

| Перевірка фінального коду | Результат |
| --- | --- |
| `node --test --test-concurrency=4 test/*.test.mjs` | **1779/1779 PASS**, 0 fail, 0 skip; 65,99 с |
| Два reject-набори | **37/37 PASS** |
| `python3 -m unittest discover -s test -p test_registry_publish.py` | **13/13 PASS** |
| Public surface, product names, naming inventory, persistence writes, artifact secrets | **PASS** |
| `git diff --check` | **PASS** |
| Незалежне Diff → Було → Стало рев’ю P1/P2 | **PASS**, без блокерів; reviewer окремо запустив тодішні 26 runtime-регресій |
| Відтворення на початковому коді | Початкові нові перевірки: **5 FAIL / 13 PASS**; виправлення усуває ці FAIL |

Node.js `v22.14.0`. Тести запускаються дочірніми процесами з allowlist `PATH, TMPDIR, LANG, LC_ALL, USER, LOGNAME, SHELL`; робоче оточення агента не змінюється. Лише синтетичні дані, локальний HTTP і тестовий software signer. Логи поза репозиторієм: `codex-runs/qcore-reject-round2-{red,targeted,full-verified,checks-final}.log`.

Код і тести збережені комітом **`b2068a0cb3c8ac6ddeaeaed145ac94c9fcdcb1c9`**, запушені в **`claude-qf/qcore-reject-branch-20261029`** канонічного origin `0design/Q-Core`. `git ls-remote` підтвердив цей SHA. Цей звіт зберігається окремим документальним комітом поверх нього; фінальний remote SHA повідомляється при здачі. **node_modules відсутній**, залежності не встановлювалися.

Межі попереднього пакета збережено: bounded loop після reject пропускає решту ітерацій; outputs відхиленого прогону/child не зв’язуються. README/SPEC/Registry синхронізація та зовнішні споживачі статусу rejected залишаються окремим release-пакетом. PR, мерж, реліз і справжні схвалення не виконувалися.
