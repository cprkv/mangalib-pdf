const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const yargs = require("yargs/yargs");
const readline = require("readline");
const { hideBin } = require("yargs/helpers");
const { spawn } = require("node:child_process");
const argv = yargs(hideBin(process.argv)).argv;
const selenium = require("selenium-webdriver");

const sa = require("superagent");
const PDFDocument = require("pdfkit");
const { assert } = require("node:console");
const maxThreads = require("os").cpus().length;

let webDriver;

const mangaUrl = argv.url;
if (!mangaUrl) {
  console.error("--url argument missing");
  process.exit(-1);
}

async function threadify(initialData, process) {
  const pAll = (await import("p-all")).default;
  const tasks = initialData.map((input) => () => process(input));
  const results = await pAll(tasks, {
    concurency: maxThreads,
  });
  return results;
}

function withReferer(req) {
  const mangaUrlParsed = url.parse(mangaUrl);
  const referer = `${mangaUrlParsed.protocol}//${mangaUrlParsed.host}`;
  return req.set("referer", referer);
}

async function isOkImage(path) {
  const p = spawn(`./image-magic/magick.exe`, ["identify", path]);
  return new Promise((resolve) => {
    p.stdout.on("data", (x) => {
      process.stdout.write(x.toString());
    });
    p.stderr.on("data", (x) => {
      process.stderr.write(x.toString());
    });
    p.on("exit", (code) => {
      resolve(code == 0);
    });
  });
}

async function convertImage(imagePath, convertPath) {
  console.log(`converting image: ${imagePath} -> ${convertPath}`);
  const p = spawn(`./image-magic/magick.exe`, [
    imagePath + "[0]",
    "-quality",
    "90",
    convertPath,
  ]);
  return new Promise((resolve) => {
    p.stdout.on("data", (x) => {
      process.stdout.write(x.toString());
    });
    p.stderr.on("data", (x) => {
      process.stderr.write(x.toString());
    });
    p.on("exit", (code) => {
      if (code == 0) {
        resolve();
      } else {
        reject(`bad status code: ${code}`);
      }
    });
  });
}

async function convertToSuitableFormat(imagePath) {
  const convertedImageName = `${imagePath}.jpg`;
  if (!fs.existsSync(convertedImageName)) {
    await convertImage(imagePath, convertedImageName);
  }
  return convertedImageName;
}

async function runWebDriver(url, title, driverAction) {
  await webDriver.get(url);
  await webDriver.wait(selenium.until.titleContains(title), 5000);
  const result = await driverAction(webDriver);
  console.log("runWebDriver result: " + JSON.stringify(result, null, 2));
  return result;
}

async function runWebDriverConsole(url, title, action) {
  return runWebDriver(url, title, async function (driver) {
    return driver.executeScript(action);
  });
}

async function getBeginReadButton(url) {
  const res = await runWebDriverConsole(url, "• MangaLIB", function () {
    return document.querySelector(".ir_by > a").href;
  });
  assert(res);
  return res;
}

async function authorize(url) {
  return runWebDriver(url, "• MangaLIB", async function () {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) =>
      rl.question("АВТОРИЗАЦИЯ. По успеху, нажмите Enter...", () => {
        rl.close();
        resolve();
      })
    );
  });
}

async function getChapterDataWebDriver(url) {
  return runWebDriverConsole(url, "Чтение", function () {
    return {
      data: window.__DATA__,
      pg: window.__pg,
      info: window.__info,
    };
  });
}

async function getWithCacheAsync(name, creator) {
  if (!fs.existsSync("./cache")) {
    fs.mkdirSync("./cache");
  }

  const hash = crypto.createHash("md5").update(name).digest("hex");
  const cacheFile = "./cache/" + hash;
  console.log(`cache ${name} -> ${cacheFile}`);

  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  }

  const data = await creator();
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

async function downloadFile(url, outfile) {
  const finishMarker = `${outfile}.done`;
  if (fs.existsSync(outfile) && fs.existsSync(finishMarker)) {
    console.log(`${outfile} already exists!`);
    return;
  }

  console.log(`downloading ${url} to ${outfile}`);
  const req = withReferer(
    sa.get(encodeURI(url)).timeout({
      response: 5000,
      deadline: 10000,
    })
  );
  const res = await req;

  if (res.status !== 200) {
    throw new Error(`bad status code: ${res.status}`);
  }

  await fs.promises.writeFile(outfile, res.body);

  if (!(await isOkImage(outfile))) {
    throw new Error(`bad image: ${outfile}`);
  }

  await fs.promises.writeFile(finishMarker, "");
}

// pages[]: { text } | { image }
async function createPDF(outFile, pages) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outFile);
    stream.on("error", () => {
      console.log("stream error");
      reject("stream error");
    });
    stream.on("finish", () => {
      resolve();
    });

    doc = new PDFDocument({
      autoFirstPage: false,
      size: "A4",
      margin: 0,
      font: fs.readFileSync(path.join(__dirname, "pt-root-ui_medium.ttf")),
    });
    // A4 (595.28 x 841.89)
    doc.pipe(stream);

    for (const page of pages) {
      if (page.text) {
        doc.addPage();
        for (const t of page.text) {
          if (t.h1) {
            doc.fontSize(64);
            doc.text(t.h1);
          } else if (t.h2) {
            doc.fontSize(48);
            doc.text(t.h2);
          } else if (t.h3) {
            doc.fontSize(32);
            doc.text(t.h3);
          }
        }
      } else if (page.image) {
        console.log(`adding image ${page.image} to pdf!`);
        doc.addPage();
        doc.image(page.image, {
          fit: [595.28, 841.89],
          // cover: [595.28, 841.89],
          align: "center",
          valign: "center",
        });
      } else {
        return reject(new Error(`unknown page structure:`, page));
      }
    }

    doc.end();
  });
}

async function downloadChapter(chapterNameSlug, mangaId, chapter) {
  const chapterInfo = await getWithCacheAsync(
    mangaUrl + ".chapterInfo-" + chapter.number,
    async () =>
      await sa
        .get(
          `https://api.cdnlibs.org/api/manga/${mangaId}/chapter?number=${chapter.number}&volume=${chapter.volume}`
        )
        .timeout({
          response: 1000,
          deadline: 5000,
        })
        .then((x) => JSON.parse(x.text).data)
  );

  const pages = [];
  for (const { slug, url } of chapterInfo.pages) {
    pages.push({ num: slug, urls: [`https://img33.imgslib.link${url}`] });
  }

  if (!fs.existsSync("./tmp")) {
    fs.mkdirSync("./tmp");
  }

  const outDir = `./tmp/${chapterNameSlug}`;
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
  }

  for (const page of pages) {
    const { num, urls } = page;

    for (const url of urls) {
      try {
        const extension = path.extname(url);
        const outfile = path.join(outDir, num + extension);
        await downloadFile(url, outfile);
        page.file = outfile;
        break;
      } catch (err) {
        console.log(`error download image: ${err}`);
      }
    }

    if (!page.file) {
      throw new Error(`error downloading image`);
    }
  }

  return pages.map((x) => x.file);
}

function runAsync(func) {
  func().catch((e) => {
    console.error(e);
    // fs.writeFileSync("error-message.json", JSON.stringify(e, null, 2));
    process.exit(1);
  });
}

function groupBy(xs, key) {
  return xs.reduce((rv, x) => {
    (rv[x[key]] = rv[x[key]] || []).push(x);
    return rv;
  }, {});
}

runAsync(async () => {
  webDriver = await new selenium.Builder().forBrowser("firefox").build();
  console.log("web driver created");

  try {
    if (argv.auth) {
      await authorize(mangaUrl);
    }

    const beginReadLink = await getWithCacheAsync(
      mangaUrl,
      async () => await getBeginReadButton(mangaUrl)
    );
    const linkParts = new URL(beginReadLink).pathname.split("/");
    const mangaId = linkParts[2];
    console.log(`manga id: ${mangaId}`);

    const chapters = await getWithCacheAsync(
      mangaUrl + ".chapters",
      async () =>
        await sa
          .get(`https://api.cdnlibs.org/api/manga/${mangaId}/chapters`)
          .timeout({
            response: 1000,
            deadline: 5000,
          })
          .then((x) => JSON.parse(x.text).data)
    );

    const info = await getWithCacheAsync(
      mangaUrl + ".info",
      async () =>
        await sa
          .get(
            `https://api.cdnlibs.org/api/manga/${mangaId}?fields[]=user&fields[]=metadata&fields[]=metadata.count&fields[]=metadata.close_comments&fields[]=chap_count&fields[]=close_view`
          )
          .timeout({
            response: 5000,
            deadline: 10000,
          })
          .then((x) => JSON.parse(x.text).data)
    );

    // TODO: parse title
    const mangaName = info.rus_name || info.eng_name || info.slug;
    if (!mangaName) {
      throw new Error("no manga name!");
    }

    console.log(`manga name: ${mangaName}`);

    const chaptersByVolume = groupBy(chapters, "volume");
    console.log(`volumes: ${Object.keys(chaptersByVolume).join(",")}`);

    let volume = argv.volume;
    if (!volume) {
      console.error("--volume argument missing");
      process.exit(-1);
    }

    volume = volume.toString().trim();

    const chaptersSelected = chapters.filter((x) => x.volume == volume);
    if (chaptersSelected.length == 0) {
      throw new Error(`volume '${volume}' not found`);
    }

    chaptersSelected.sort((a, b) => +a.item_number - +b.item_number);

    console.log(
      "selected volume:",
      chaptersSelected.map((x) => x.number).join(" ")
    );
    const volumePages = []; // {text}|{image}

    for (const chapter of chaptersSelected) {
      const { name, item_number, volume, branches } = chapter;
      const chapterNameSlug = `${info.slug}-v${volume}-c${item_number}`;
      const volumeName = name.trim().length ? `Глава ${item_number}: ${name}` : `Глава ${item_number}`;
      const chapterName = [
        { h1: mangaName },
        { h2: `Том ${volume}` },
        { h3: volumeName },
      ];

      const chapterPages = await downloadChapter(
        chapterNameSlug,
        mangaId,
        chapter
      );

      volumePages.push({ text: chapterName });

      const convertedImages = await threadify(chapterPages, async (image) => {
        return await convertToSuitableFormat(image);
      });

      for (const image of convertedImages) {
        volumePages.push({ image });
      }
    }

    console.dir(volumePages);

    if (!fs.existsSync("./out")) {
      fs.mkdirSync("./out");
    }

    const outPdf = `./out/${info.slug}-v${volume}.pdf`;
    await createPDF(outPdf, volumePages);

    console.log("done!", outPdf);
  } finally {
    await webDriver.quit();
  }
});
