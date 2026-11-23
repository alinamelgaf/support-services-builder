# Неопубликованные изменения SSB

После завершения доработки внесите сюда краткое описание, статус проверки и коммит. Обновляйте статус по итогам проверки. После выхода официальной версии удалите из списка вошедшие в неё пункты.

Последний выпуск — [1.3.0 от 18 ноября 2026 г.](https://github.com/alinamelgaf/support-services-builder/releases/tag/v1.3.0). Изменения вошли в [CHANGELOG](../CHANGELOG.md#130--2026-11-18). На проверке 23 ноября рабочий сайт показывал 1.3.0. Завершённые пункты предыдущего цикла сняты с учёта; их отчёты и история Git сохранены.

| Изменение | Статус | Коммит |
|---|---|---|
| Удалён локальный запускатель завершённого PWA-стенда и его исключение из локального Git; старые инструкции архивированы. Внешние компоненты оставлены до отдельного решения. [Отчёт](PWA_AUDIT_CLEANUP_REPORT.md) | 39 тестов, обе сборки и аудит пройдены. Импорт/экспорт и изоляция dev проверены в Chrome/Edge. PWA-регрессия Edge пройдена; Chrome остановился на ошибке CacheStorage в новом профиле. Приложение и ресурсы production не изменены. Только локальная dev. | `720f435` |

## Отчёты завершённого цикла 1.3.0

[Подготовка 1.3.0](SSB_1.3.0_RELEASE_REPORT.md) · [Личный шаблон](PERSONAL_TEMPLATE_REPORT.md) · [Автосохранение палитры](PALETTE_AUTOSAVE_REPORT.md) · [Первоначальная палитра](DOCUMENT_PALETTE_REPORT.md) · [Прежние подтверждения палитры](PALETTE_CONFIRMATION_REPORT.md) · [Визуальный стиль](UI_COMPACT_REPORT.md) · [Источники Confluence](CONFLUENCE_INTERFACE_REPORT.md) · [Тексты уведомлений](TEXT_NOTICES_REPORT.md) · [Очистка данных](CONFLUENCE_CLEARING_REPORT.md) · [Таблица и кнопки](TABLE_WORKSPACE_REPORT.md)
[Проверка импорта необязательных источников](CONFLUENCE_OPTIONAL_SOURCES_REPORT.md) · [Проверка уведомлений о настройках](DEFAULTS_NOTICE_REPORT.md)

[Отчёт об импорте и подготовке 1.2.1](SSB_1.2.1_IMPORT_REPORT.md)

[Отчёт об установке, ярлыках и обновлениях PWA](PWA_IDENTITY_AUDIT_REPORT.md)

[Инструкция](LOCAL_DEVELOPMENT.md) · [Отчёт о локальной среде](LOCAL_DEVELOPMENT_REPORT.md) · [Отчёт о разделах Confluence и SLA](CONFLUENCE_SECTIONS_REPORT.md) · [Отчёт о представлениях SLA](SLA_LAYOUT_REPORT.md) · [Отчёт об ориентации SLA и прокрутке Excel](SLA_TIMING_REPORT.md) · [Отчёт о названиях пакетов](SUPPORT_LABELS_REPORT.md) · [Отчёт о проверке обновлений PWA](PWA_UPDATE_PREVIEW_REPORT.md) · [Отчёт об оформлении уведомлений и выгрузок](INTERFACE_EXPORT_POLISH_REPORT.md) · [Отчёт о верхних кнопках](HEADER_LAYOUT_REPORT.md) · [Отчёт о сравнительной SLA в Word и прокрутке Excel](WORD_SLA_EXCEL_COLUMNS_REPORT.md) · [Отчёт о заголовках таблиц](TABLE_HEADERS_REPORT.md)
