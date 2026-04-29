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

// =====================
// GLOBAL STATE
// =====================
let browser = null;
let isScraping = false;
let browserReady = false;

// =====================
// SAFE LOGGER (prevents Railway log spam)
// =====================
const log = (...args) => {
  if (process.env.NODE_ENV !== "production") {
    console.log(...args);
  }
};

// =====================
// BROWSER INIT (AUTO RECOVERY)
// =====================
async function initBrowser() {
  try {
    log("🚀 Launching browser...");

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
    log("✅ Browser ready");
  } catch (err) {
    console.error("❌ Browser launch failed:", err.message);
    browserReady = false;

    setTimeout(initBrowser, 5000);
  }
}

initBrowser();

// =====================
// SAFE BROWSER GETTER
// =====================
async function getBrowser() {
  if (!browser || !browser.isConnected?.()) {
    console.log("♻️ Browser restarted...");
    browserReady = false;
    await initBrowser();
  }

  return browser;
}

// =====================
// SCRAPER CORE (FIXED EPISODE SKIPPING ISSUE)
// =====================
async function scrapeEpisodes() {
  if (isScraping) return;
  if (!browserReady) return;

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

        page = await safeBrowser.newPage();

        console.log(`Scraping ${episode.animeId}`);

        await page.goto(episode.episodeHref, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        await page.waitForSelector("#episode-servers > li", {
          timeout: 15000,
        });

        // =========================
        // FIX: STABLE SERVER LOOP
        // =========================
        const serverCount = await page.$$eval(
          "#episode-servers > li",
          els => els.length
        );

        let serversLinks = [];

        for (let i = 0; i < serverCount; i++) {

          // 🔥 ALWAYS RE-FETCH ELEMENTS (fix skip issue)
          const servers = await page.$$("#episode-servers > li");
          const server = servers[i];

          if (!server) continue;

          await server.click();

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

          // small delay → prevents DOM race issues
          await new Promise(r => setTimeout(r, 700));
        }

        // =========================
        // INSERT DB (NO DUPLICATES)
        // =========================
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

        await new Promise(r => setTimeout(r, 1000));

      } catch (error) {
        console.error("Scrape error:", error.message);

        if (page) {
          try {
            await page.close();
          } catch {}
        }

        // browser recovery
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
// API
// =====================
app.get("/scrape", (req, res) => {
  scrapeEpisodes();

  res.json({
    success: true,
    message: "Scraping started 🚀",
  });
});

app.get("/status", (req, res) => {
  res.json({
    scraping: isScraping,
    browserReady,
  });
});

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
