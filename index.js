const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2");

const app = express();
app.use(express.json());

// =====================
// DB
// =====================
const db = mysql.createConnection({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQL_ROOT_PASSWORD,
  database: process.env.MYSQLDATABASE,
});

db.connect(err => {
  if (err) {
    console.error("DB connection error:", err.message);
    return;
  }
  console.log("Connected to MySQL");
});

// ---------------- SCRAPER LOCK ----------------
let isScraping = false;

// ---------------- SCRAPER ----------------
async function runScraper() {
  if (isScraping) {
    console.log("Scraper already running...");
    return;
  }

  isScraping = true;

  let browser;

  try {
    console.log("Starting scraper...");

    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // IMPORTANT for Railway
    });

    const page = await browser.newPage();

    const results = await new Promise((resolve, reject) => {
      db.query("SELECT * FROM episodes", (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    for (const episode of results) {
      console.log(`Scraping anime ${episode.animeId} | ${episode.episodeHref}`);

      try {
        await page.goto(episode.episodeHref, { waitUntil: "networkidle" });

        await page.waitForSelector("#episode-servers > li", { timeout: 15000 });

        const serverCount = await page.$$eval("#episode-servers > li", els => els.length);

        let serversLinks = [];

        for (let i = 0; i < serverCount; i++) {
          console.log(`Clicking server ${i + 1}`);

          const servers = await page.$$("#episode-servers > li");
          await servers[i].click();

          await page.waitForSelector("#iframe-container > iframe", { timeout: 15000 });

          const frameHandle = await page.$("#iframe-container > iframe");
          const frame = await frameHandle?.contentFrame();
          if (!frame) continue;

          await frame.waitForTimeout(2000);

          const playerSelector =
            "#PlayerDisplay > div.OptionsLangDisp > div > div > li";

          const hasList = await frame.$(playerSelector);

          if (hasList) {
            const encodedList = await frame.$$eval(playerSelector, items =>
              items
                .map(item => {
                  const onclick = item.getAttribute("onclick");
                  if (!onclick) return null;

                  const match = onclick.match(/go_to_player\('([^']+)'\)/);
                  return match ? match[1] : null;
                })
                .filter(Boolean)
            );

            const decodedList = encodedList.map(encoded =>
              Buffer.from(encoded, "base64").toString("utf-8")
            );

            serversLinks.push(...decodedList);
          } else {
            const videoLink = await frame.$eval("video", video =>
              video.src || video.currentSrc || video.getAttribute("src")
            ).catch(() => null);

            if (videoLink) serversLinks.push(videoLink);
          }
        }

        console.log("FINAL LINKS:", serversLinks);

        if (serversLinks.length > 0) {
          const values = serversLinks.map(link => [
            episode.id,
            link,
            episode.animeId,
          ]);

          db.query(
            "INSERT INTO servers (episodeId, serverLink, animeId) VALUES ?",
            [values],
            err => {
              if (err) console.error("Insert error:", err);
              else console.log(`Inserted ${values.length} links`);
            }
          );
        }
      } catch (err) {
        console.error("Scrape error:", episode.animeId, err.message);
      }
    }

    console.log("Scraping finished.");
  } catch (err) {
    console.error("Fatal scraper error:", err);
  } finally {
    if (browser) await browser.close();
    isScraping = false;
  }
}

// ---------------- ROUTES ----------------

// health check
app.get("/", (req, res) => {
  res.send("Scraper server is running 🚀");
});

// trigger scraper manually
app.get("/scrape", async (req, res) => {
  runScraper();
  res.json({ status: "Scraping started" });
});

// optional auto scrape on start
app.get("/scrape-once", async (req, res) => {
  await runScraper();
  res.json({ status: "Scraping finished" });
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
