# Claude Code: потрібна повторна авторизація

Перевірено 10.09.2026, CLI 2.1.156.

Read-only `claude auth status` показав loggedIn=true, claude.ai / firstParty / Max. Це підтверджує збережений вхід, але не чинність токена. Два фактичні свіжі виклики з точними Start/Use промптами завершилися exit 1 до генерації чи виконання інструментів:

> Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.

Мінімальна дія власника в терміналі:

```sh
/usr/local/bin/claude auth login --claudeai
```

Команда входу не запускалася автоматично. `--claudeai` використовує підписку Claude; не обрано API billing. Після входу треба повторити фактичні сценарії; матриця Claude зараз не пройдена. Customize/Create не запускалися після однакової auth-помилки Start/Use.

Тестовий отримувач зупинено; жодних HTTP-запитів до нього не було. Секрети й особисті ідентифікатори до звіту не включені. [Структурований статус](../claude-auth-current.json). Raw evidence: ../golden-parent/start-claude/ та ../golden-parent/use-claude/.

Підтримуваний headless mode і OAuth/bare-mode відмінність звірені з [офіційною документацією Claude](https://code.claude.com/docs/en/headless); синтаксис login підтверджений локальним --help. Permission bypass, bare-mode з іншим ключем та копіювання credentials не використовувались.
