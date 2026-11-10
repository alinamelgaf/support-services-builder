# Support Services Builder

Русскоязычный конструктор услуг технического сопровождения. Загружает JSON Confluence Data Center, сравнивает Standard, Extended и Managed Service и формирует Excel и Word в браузере.

## Для менеджера

Распакуйте автономную поставку и откройте `index.html` в Chrome или Edge. Если организация разместила PWA на HTTPS, можно установить её через меню браузера. [Установка и первый запуск](docs/INSTALL.md) · [Получение и импорт JSON](docs/CONFLUENCE_IMPORT.md)

## Для разработки

Требуются Node.js 24.22.1 и pnpm 11.25.0. Пользовательские версии не требуют этих инструментов.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm package
```

| Каталог | Содержимое |
| --- | --- |
| `src/`, `config/` | Интерфейс, импортер REST, три слоя данных, единая модель предложения и экспорт документов. |
| `pwa/` | Манифест, иконки и исходник Service Worker. |
| `tests/`, `examples/` | Проверки и искусственный пример. |
| `dist/` | Статический сайт для HTTPS. |
| `standalone/`, `release/` | Автономный `index.html` и ZIP-поставки. |
| `scripts/`, `.github/workflows/` | Проверка поставки, упаковка и подготовка одобренных релизов. |

[Публикация на GitHub](docs/GITHUB_PUBLICATION.md) · [Обновления](docs/UPDATES.md) · [Отчёт о тестировании](docs/SSB_TEST_REPORT.md) · [Отчёт о безопасности](docs/SSB_SECURITY_REPORT.md)
