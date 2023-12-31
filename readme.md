# mangalib-pdf

Собиралка PDF из картинок с сайта мангалиб.

![screenshot](./docs/screen.jpg)

## Устновка

См. страницу с релизами. В каждом релизе содержится исполняемый файл установщика. Нужно его запустить и установить.

## Как использовать

- Запустить программу можно через меню пуск. В строке URL нужно вбить адрес манги, без квери параметров и прочего. Например: `https://mangalib.me/ijiranaide-nagatoro-san`.
- Затем нажать `Get volumes`, и выбрать том манги из выпадаюшего списка.
- Затем нажать `To PDF`, откроется диалог выбора директории куда нужно сохранить пдф-файл. Имя файлу будет задано автоматически. Выбор директории сделан не очень удобно, но программа автоматически запоминает последнюю выбранную директорию.
- По завершении, программа предложит открыть папку с выходным файлом.

## Директории

Во время работы скрипт создаст 2 директории:

- `%LOCALAPPDATA%/mangalib/cache` - кэш html файлов скаченных с сайта. не занимает много места на диске и можно не очищать.
- `%LOCALAPPDATA%/mangalib/cache` - кэш картинок. нужен для того, чтобы если скрипт завис или сломался на каком-то месте, можно было запустить его заново и он продолжит работу с того же места. обычно занимает много места на диске, и после скачивания нужных томов манги его лучше чистить (просто удалить эту папку).

## Как собирать

- установить свежую версию Go
- установить [MinGW-w64 based TDM-GCC](https://jmeubank.github.io/tdm-gcc/)
- запустить `./make-dist.ps1` в пауэршеле
