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
    console.error("DB connection error:", err);
    return;
  }
  console.log("Connected to MySQL");
});

// =====================
// GLOBAL STATE
// =====================
let browser = null;
let isScraping = false;

// =====================
// INIT BROWSER (REUSED)
// =====================
(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process"
    ],
  });

  console.log("Browser launched");
})();

// =====================
// SCRAPER CORE
// =====================
async function scrapeEpisodes() {
  if (isScraping) {
    console.log("Scraper already running...");
    return;
  }

  isScraping = true;

  try {
    db.query(
      "SELECT * FROM episodes",
      async (err, results) => {
        if (err) {
          console.error(err);
          isScraping = false;
          return;
        }

        if (!results.length) {
          console.log("No episodes to scrape");
          isScraping = false;
          return;
        }

        for (const episode of results) {
          console.log(
            `Scraping anime ${episode.animeId} | ${episode.episodeHref}`
          );

          let page;

          try {
            page = await browser.newPage();

            await page.goto(episode.episodeHref, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });

            await page.waitForSelector("#episode-servers > li", {
              timeout: 10000,
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
                timeout: 10000,
              });

              const frameHandle = await page.$(
                "#iframe-container > iframe"
              );

              const frame = await frameHandle?.contentFrame();
              if (!frame) continue;

              await frame.waitForTimeout(1500);

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
                        if (!onclick) return null;

                        const match = onclick.match(
                          /go_to_player\('([^']+)'\)/
                        );
                        return match ? match[1] : null;
                      })
                      .filter(Boolean)
                );

                const decodedList = encodedList.map(encoded =>
                  Buffer.from(encoded, "base64").toString("utf-8")
                );

                serversLinks.push(...decodedList);
              } else {
                const videoLink = await frame
                  .$eval("video", video =>
                    video.src ||
                    video.currentSrc ||
                    video.getAttribute("src")
                  )
                  .catch(() => null);

                if (videoLink) serversLinks.push(videoLink);
              }
            }

            console.log("FINAL LINKS:", serversLinks);

            // =====================
            // INSERT (NO DUPLICATES)
            // =====================
            if (serversLinks.length > 0) {
              const values = serversLinks.map(link => [
                episode.id,
                link,
                episode.animeId,
              ]);

              const query = `
                INSERT IGNORE INTO servers (episodeId, serverLink, animeId)
                VALUES ?
              `;

              db.query(query, [values], err => {
                if (err) console.error("Insert error:", err);
                else console.log(`Inserted ${values.length} links`);
              });
            }

            // =====================
            // MARK AS SCRAPED
            // =====================
            

            await page.close();

            // small delay to prevent CPU spike
            await new Promise(r => setTimeout(r, 800));
          } catch (error) {
            console.error(
              "Scrape error:",
              episode.animeId,
              error.message
            );

            if (page) await page.close();
          }
        }

        console.log("Scraping batch completed");
        isScraping = false;
      }
    );
  } catch (err) {
    console.error("Fatal scrape error:", err);
    isScraping = false;
  }
}

// =====================
// API ROUTES
// =====================

// trigger scraper (NON-BLOCKING)
app.get("/scrape", (req, res) => {
  scrapeEpisodes();

  res.json({
    success: true,
    message: "Scraping started in background 🚀",
  });
});

// status endpoint
app.get("/status", (req, res) => {
  res.json({
    scraping: isScraping,
  });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
