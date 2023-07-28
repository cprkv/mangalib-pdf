const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const argv = yargs(hideBin(process.argv)).argv;

const sa = require("superagent");
const cheerio = require("cheerio");
const PDFDocument = require("pdfkit");

const { session } = require("./config.json");

const mangaUrl = argv.url;
if (!mangaUrl) {
  console.error("--url argument missing");
  process.exit(-1);
}

function withAuthorization(req) {
  const mangaUrlParsed = url.parse(mangaUrl);
  const referer = `${mangaUrlParsed.protocol}//${mangaUrlParsed.host}`;
  if (session) {
    return req
      .set("referer", referer)
      .set("cookie", `mangalib_session=${session}`);
  }
  return req.set("referer", referer);
}

async function getHtml(url) {
  const headers = {
    "user-agent": "curl/7.84.0",
    accept: "*/*",
    cookie: "mangalib_session=",
  };
  const page = await withAuthorization(
    sa.get(url).withCredentials().set(headers).http2()
  );
  return page.text;
}

async function getMangaData(html) {
  const $ = cheerio.load(html);
  const scripts = [$("#pg").text()];

  $("script").each(function () {
    const current = $(this);
    if (current.text() && current.text().includes("window.__DATA__")) {
      scripts.push(current.text());
    }
  });

  if (scripts.length != 2) {
    throw new Error("something wrong with scripts. no __DATA__ found?");
  }

  const window = {};
  for (const script of scripts) {
    eval(script);
  }

  return window;
}

async function getWithCacheAsync(name, creator) {
  if (!fs.existsSync("./cache")) {
    fs.mkdirSync("./cache");
  }

  const hash = crypto.createHash("md5").update(name).digest("hex");
  const cacheFile = "./cache/" + hash;

  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, "utf-8");
  }

  const data = await creator();
  fs.writeFileSync(cacheFile, data);
  return data;
}

async function downloadFile(url, outfile) {
  const finishMarker = `${outfile}.done`;
  if (fs.existsSync(outfile) && fs.existsSync(finishMarker)) {
    console.log(`${outfile} already exists!`);
    return;
  }

  return new Promise((resolve, reject) => {
    console.log(`downloading ${url} to ${outfile}`);
    const stream = fs.createWriteStream(outfile);
    const req = withAuthorization(sa.get(encodeURI(url)));
    req.pipe(stream);

    req.on("response", (res) => {
      console.log(`response: ${res.status}`);
    });

    stream.on("error", () => {
      console.log("stream error");
      reject("stream error");
    });

    stream.on("finish", () => {
      fs.writeFileSync(finishMarker, "");
      resolve();
    });
  });
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

async function downloadChapter(mangaName, chapterUrl) {
  const html = await getWithCacheAsync(chapterUrl, async () =>
    getHtml(chapterUrl)
  );
  const window = await getMangaData(html);

  const pages = [];
  for (const { p, u } of window.__pg) {
    const num = p;
    const url = window.__info.servers.main + window.__info.img.url + u;
    pages.push({ num, url });
  }

  if (!fs.existsSync(mangaName)) {
    fs.mkdirSync(mangaName);
  }

  for (const page of pages) {
    const { num, url } = page;
    const extension = path.extname(url);
    const outfile = path.join(mangaName, num + extension);
    await downloadFile(url, outfile);
    page.file = outfile;
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
  const html = await getWithCacheAsync(mangaUrl, async () => getHtml(mangaUrl));
  const window = await getMangaData(html);

  const { manga, chapters } = window.__DATA__;

  const mangaName = manga.rusName || manga.engName || manga.slug;
  if (!mangaName) {
    console.dir(window.__DATA__);
    throw new Error("no manga name!");
  }

  console.log(`manga name: ${mangaName}`);

  const chaptersByVolume = groupBy(chapters.list, "chapter_volume");
  console.log(`volumes: ${Object.keys(chaptersByVolume).join(",")}`);

  let volume = argv.volume;
  if (!volume) {
    console.error("--volume argument missing");
    process.exit(-1);
  }

  volume = volume.toString().trim();

  const chaptersSelected = chapters.list.filter(
    (x) => x.chapter_volume == volume
  );
  if (chaptersSelected.length == 0) {
    throw new Error(`volume '${volume}' not found`);
  }

  chaptersSelected.sort((a, b) => +a.chapter_number - +b.chapter_number);

  console.log("selected volume:", chaptersSelected);
  const volumePages = []; // {text}|{image}

  for (const {
    chapter_slug,
    chapter_name,
    chapter_number,
    chapter_volume,
  } of chaptersSelected) {
    const chapterNameSlug = `${manga.slug}-v${chapter_volume}-c${chapter_number}`;
    const chapterName = [
      { h1: mangaName },
      { h2: `Том ${chapter_volume}` },
      { h3: `Глава ${chapter_number}: ${chapter_name}` },
    ];
    const chapterUrl = `${mangaUrl}/v${chapter_volume}/c${chapter_number}`;
    console.log(chapterNameSlug, chapterUrl);

    const chapterPages = await downloadChapter(chapterNameSlug, chapterUrl);

    volumePages.push({ text: chapterName });
    for (const image of chapterPages) {
      // skip inappropriate formats
      if (!image.endsWith(".gif")) {
        volumePages.push({ image });
      }
    }
  }

  console.dir(volumePages);
  const outPdf = `${manga.slug}-v${volume}.pdf`;
  await createPDF(outPdf, volumePages);

  console.log("done!", outPdf);
});
