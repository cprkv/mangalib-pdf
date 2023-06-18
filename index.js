const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

const sa = require("superagent");
const cheerio = require("cheerio");
const PDFDocument = require("pdfkit");

const { mangaUrl, session } = require("./config.json");

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
  if (fs.existsSync(outfile)) {
    console.log(`${outfile} already exists!`);
    return;
  }

  return new Promise((resolve, reject) => {
    console.log(`downloading ${url} to ${outfile}`);
    const stream = fs.createWriteStream(outfile);
    const req = withAuthorization(sa.get(url));
    req.pipe(stream);

    stream.on("error", () => {
      console.log("stream error");
      reject("stream error");
    });

    stream.on("finish", () => {
      resolve();
    });
  });
}

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

    doc = new PDFDocument({ autoFirstPage: false, size: "A4", margin: 0 });
    // A4 (595.28 x 841.89)
    doc.pipe(stream);

    for (const page of pages) {
      console.log(`adding page ${page} to pdf!`);
      doc.addPage();
      doc.image(page, {
        fit: [595.28, 841.89],
        // cover: [595.28, 841.89],
        align: "center",
        valign: "center",
      });
    }

    doc.end();
  });
}

runAsync(async () => {
  const html = await getWithCacheAsync(mangaUrl, async () => getHtml(mangaUrl));
  const window = await getMangaData(html);

  const mangaName =
    window.__DATA__.current.chapter_name ||
    window.__DATA__.manga.slug ||
    window.__DATA__.current.id.toString() ||
    window.__DATA__.manga.slug.id.toString();
  if (!mangaName) {
    console.dir(window.__DATA__);
    throw new Error("no manga name!");
  }
  console.log(`manga name: "${mangaName}"`);

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

  await createPDF(
    `${mangaName}.pdf`,
    pages.map((x) => x.file)
  );

  console.log("done!");
});

function runAsync(func) {
  func().catch((e) => {
    console.error(e);
    // fs.writeFileSync("error-message.json", JSON.stringify(e, null, 2));
    process.exit(1);
  });
}
