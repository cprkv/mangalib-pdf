# mangalib-pdf

Собиралка PDF из картинок с сайта мангалиб.

## Конфиг

Создать файл `config.json` в директории приложения:

```json
{
  "mangaUrl": "https://mangalib.me/toradora",
  "session": null
}
```

Параметр сессии нужен, если манга "приватная", т.е. например для всех манг с подсайта hentailib.

## Как запускать

```
npm i
node index.js
```
