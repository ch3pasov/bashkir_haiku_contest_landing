# Bashkir Haiku Contest

Static archive of a Bashkir-language haiku contest held in February 2024.

[Open the archive](https://bashkirhaiku.anatoliy.ch/) · [Read the final post](https://t.me/ch_an/1902)

![Bashkir Haiku Contest illustration](html/img/og_image.webp)

Participants submitted original three-line haiku in Bashkir through a Telegram discussion. Each person could enter up to five poems. Three jury members selected three different winners, with physical prizes for the winning entries.

The website preserves the rules, jury and contributor credits, Telegram discussion widget, and final post from the completed contest.

## Repository

The archive is a single static HTML page served by nginx in Docker Compose. It uses Bootstrap and Telegram's native post and discussion widgets.

For a quick local preview:

```sh
python3 -m http.server 8000 --directory html
```

Then open <http://localhost:8000>.

## Публикация в Cloudflare

Рабочий сайт: https://bashkirhaiku.anatoliy.ch. Исходные страницы редактируются в `html/`.
Каждый push в `main` автоматически проверяет сборку и публикует новую версию
существующего Worker `anatoliy-bashkir-haiku` через GitHub Actions. Pull requests проверяются
без публикации; ручной запуск доступен в Actions → Publish to Cloudflare → Run workflow.

GitHub Secret `CLOUDFLARE_API_TOKEN` содержит отдельный токен с правом Workers Editor
для аккаунта владельца. Значение токена не хранится в файлах репозитория.
Публикация использует `wrangler versions upload` и `wrangler versions deploy`:
DNS, домены, VPS и другие Workers не изменяются.

Для проверки локально: `cd cloudflare`, затем `npm ci`, `npm test`, `npm run check:build`.
Настройки — `cloudflare/wrangler.json`, команды CI — `.github/workflows/cloudflare.yml`.
В Actions сохраняются commit SHA, опубликованная версия и прежняя версия для отката.
Если проверка работоспособности после публикации не проходит, CI возвращает прежние
версии и отмечает запуск как неуспешный. Для ручного отката можно выбрать прежнюю
версию в Cloudflare → Worker → Deployments.

Проверка после публикации учитывает Cloudflare Challenge для серверов GitHub: только ответ 403 с `cf-mitigated: challenge` проверяется через `workers.dev` вместе с привязкой основного домена из Cloudflare API. Этот случай явно отмечается в отчёте Actions; проверку содержимого основного домена из GitHub он не подтверждает. Обычный 403, неверная привязка или несовпадение файлов вызывают откат. Защита Cloudflare и DNS при публикации не меняются.
