# mangalib-pdf

Собиралка PDF из картинок с сайта мангалиб.

## Конфиг

1. Создать файл `config.json` в директории приложения:
    ```json
    {
      "session": null
    }
    ```

    Параметр сессии нужен, если манга "приватная", т.е. например для всех манг с подсайта hentailib.

2. Установить зависимости:
    ```
    npm i
    ```

## Как запускать

```
node index.js --url https://mangalib.me/toradora
node index.js --url https://mangalib.me/toradora --volume 10
```
