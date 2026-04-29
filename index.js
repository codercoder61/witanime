const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2");

const app = express();
app.use(express.json());

// =====================
// DB CONNECTION
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

// =====================
// GLOBAL STATE
// =====================
let browser = null;
let isScraping = false;
let browserReady = false;

// =====================
// SAFE BROWSER LAUNCH (AUTO RECOVERY)
// =====================
async function initBrowser() {
  try {
    console.log("🚀 Starting browser...");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process",
      ],
    });

    browserReady = true;
    console.log("✅ Browser ready");
  } catch (err) {
    console.error("❌ Browser failed:", err.message);
    browserReady = false;

    setTimeout(initBrowser, 5000);
  }
}

initBrowser();

// =====================
// SAFE BROWSER GETTER (FIX FOR YOUR ERROR)
// =====================
async function getBrowser() {
  if (!browser || !browser.isConnected?.()) {
    console.log("♻️ Browser was closed → restarting...");

    browserReady = false;
    await initBrowser();
  }

  return browser;
}

// =====================
// SCRAPER CORE
// =====================
async function scrapeEpisodes() {
  if (isScraping) {
    console.log("Scraper already running...");
    return;
  }

  if (!browserReady) {
    console.log("Browser not ready");
    return;
  }

  isScraping = true;

  db.query("SELECT * FROM episodes", async (err, results) => {
    if (err) {
      console.error("DB error:", err.message);
      isScraping = false;
      return;
    }

    if (!results.length) {
      console.log("No episodes found");
      isScraping = false;
      return;
    }

    for (const episode of results) {
      let page;

      try {
        const safeBrowser = await getBrowser();

        // 🔥 FIX HERE (prevents your crash)
        page = await safeBrowser.newPage();

        console.log(`Scraping ${episode.animeId}`);

        await page.goto(episode.episodeHref, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        await page.waitForSelector("#episode-servers > li", {
          timeout: 15000,
        });

        const serverCount = await page.$$eval(
          "#episode-servers > li",
          els => els.length
        );

        let serversLinks = [];

        for (let i = 0; i < serverCount; i++) {
          const servers = await page.$$("#episode-servers > li");
          if (!servers[i]) continue;

          await servers[i].click();

          await page.waitForSelector("#iframe-container > iframe", {
            timeout: 15000,
          });

          const frameHandle = await page.$("#iframe-container > iframe");
          const frame = await frameHandle?.contentFrame();

          if (!frame) continue;

          await frame.waitForTimeout(1000);

          const playerSelector =
            "#PlayerDisplay > div.OptionsLangDisp > div > div > li";

          const hasList = await frame.$(playerSelector);

          if (hasList) {
            const encodedList = await frame.$$eval(
              playerSelector,
              items =>
                items
                  .map(item => {
                    const onclick = item.getAttribute("onclick");
                    const match = onclick?.match(/go_to_player\('([^']+)'\)/);
                    return match ? match[1] : null;
                  })
                  .filter(Boolean)
            );

            const decoded = encodedList.map(e =>
              Buffer.from(e, "base64").toString("utf-8")
            );

            serversLinks.push(...decoded);
          } else {
            const videoLink = await frame
              .$eval("video", v =>
                v.src || v.currentSrc || v.getAttribute("src")
              )
              .catch(() => null);

            if (videoLink) serversLinks.push(videoLink);
          }
        }

        // =====================
        // INSERT DB (NO DUPLICATES)
        // =====================
        if (serversLinks.length > 0) {
          const values = serversLinks.map(link => [
            episode.id,
            link,
            episode.animeId,
          ]);

          db.query(
            "INSERT IGNORE INTO servers (episodeId, serverLink, animeId) VALUES ?",
            [values],
            err => {
              if (err) console.error("Insert error:", err.message);
            }
          );
        }

        await page.close();

        // small delay (IMPORTANT for Railway stability)
        await new Promise(r => setTimeout(r, 800));

      } catch (error) {
        console.error("Scrape error:", error.message);

        if (page) {
          try {
            await page.close();
          } catch {}
        }

        // 🔥 FIX: browser died → restart it
        if (error.message.includes("Target browser")) {
          browserReady = false;
          await initBrowser();
        }
      }
    }

    console.log("Scraping completed");
    isScraping = false;
  });
}

// =====================
// API ROUTES
// =====================
app.get("/scrape", (req, res) => {
  scrapeEpisodes();

  res.json({
    success: true,
    message: "Scraping started in background 🚀",
  });
});

app.get("/status", (req, res) => {
  res.json({
    scraping: isScraping,
    browserReady,
  });
});

// =====================
// HEALTH CHECK
// =====================
app.get("/", (req, res) => {
  res.send("OK");
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
