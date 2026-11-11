# Support Services Builder

Русскоязычный конструктор услуг технического сопровождения. Загружает JSON Confluence Data Center, сравнивает Standard, Extended и Managed Service и формирует Excel и Word в браузере.

## Для менеджера

Откройте HTTPS-адрес PWA и установите приложение через Chrome или Edge. Для резервной работы распакуйте автономную поставку и откройте `index.html`. [Руководство пользователя](docs/USER_GUIDE.md) · [История изменений](CHANGELOG.md)

## Для разработки

Требуются Node.js 24.22.1 и pnpm 11.25.0. Пользовательские версии не требуют этих инструментов.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm check:release
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm package
```

Для локального тестирования на Windows откройте **Start SSB Test.cmd**. Сервер показывает тестовую версию на `http://localhost:4173/` и пересобирает её при правках. [Локальная разработка](docs/LOCAL_DEVELOPMENT.md) · [Тестовая сборка](docs/DEV_BUILD.md)

| Каталог | Содержимое |
| --- | --- |
| `src/`, `config/` | Интерфейс, импортер REST, три слоя данных, единая модель предложения и экспорт документов. |
| `pwa/` | Манифест, иконки и исходник Service Worker. |
| `tests/`, `examples/` | Проверки и искусственный пример. |
| `dist/` | Статический сайт для HTTPS. |
| `standalone/`, `release/` | Автономный `index.html` и ZIP-поставки. |
| `scripts/`, `.github/workflows/` | Проверка поставки, упаковка и подготовка одобренных релизов. |

[Первая публикация](docs/GITHUB_PUBLICATION.md) · [Выпуск версий](docs/RELEASING.md) · [Обновления](docs/UPDATES.md) · [Откат](docs/ROLLBACK.md) · [Безопасность](docs/SECURITY.md)

## Лицензия

Исходный код распространяется по [лицензии MIT](LICENSE). Уведомления о лицензиях сторонних библиотек включены в обе сборки отдельным файлом `THIRD_PARTY_NOTICES.txt`.
