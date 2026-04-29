const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2");

const app = express();
app.use(express.json());


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

// 👉 SCRAPER FUNCTION (separated logic)
async function scrapeEpisodes() {
  return new Promise((resolve, reject) => {
    db.query("SELECT * FROM episodes", async (err, results) => {
      if (err) return reject(err);

      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      for (const episode of results) {
        console.log(`Scraping anime ${episode.animeId} | ${episode.episodeHref}`);

        try {
          await page.goto(episode.episodeHref, { waitUntil: "networkidle" });

          await page.waitForSelector("#episode-servers > li", { timeout: 10000 });

          const serverCount = await page.$$eval(
            "#episode-servers > li",
            els => els.length
          );

          let serversLinks = [];

          for (let i = 0; i < serverCount; i++) {
            console.log(`Clicking server ${i + 1}`);

            const servers = await page.$$("#episode-servers > li");
            await servers[i].click();

            await page.waitForSelector("#iframe-container > iframe", {
              timeout: 10000,
            });

            const frameHandle = await page.$("#iframe-container > iframe");
            const frame = await frameHandle?.contentFrame();
            if (!frame) continue;

            await frame.waitForLoadState?.("networkidle").catch(() => {});
            await frame.waitForTimeout(2000);

            const playerSelector =
              "#PlayerDisplay > div.OptionsLangDisp > div > div > li";

            const hasList = await frame.$(playerSelector);

            if (hasList) {
              await frame.waitForSelector(playerSelector);

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
              const videoSelector = "video";

              await frame.waitForSelector(videoSelector, { timeout: 10000 }).catch(() => null);

              const videoLink = await frame
                .$eval(videoSelector, video =>
                  video.src || video.currentSrc || video.getAttribute("src")
                )
                .catch(() => null);

              serversLinks.push(videoLink);
            }
          }

          console.log("FINAL LINKS:", serversLinks);

          if (serversLinks.length > 0) {
            const values = serversLinks.map(link => [
              episode.id,
              link,
              episode.animeId,
            ]);

            const query =
              "INSERT INTO servers (episodeId, serverLink, animeId) VALUES ?";

            db.query(query, [values], err => {
              if (err) console.error("Insert error:", err);
              else console.log(`Inserted ${values.length} links`);
            });
          }
        } catch (error) {
          console.error("Scrape error:", episode.animeId, error.message);
        }
      }

      await browser.close();
      resolve("Scraping completed");
    });
  });
}

// 👉 ROUTE TO TRIGGER SCRAPING
app.get("/scrape", async (req, res) => {
  try {
    const result = await scrapeEpisodes();
    res.json({ success: true, message: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});


const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
