const { chromium } = require("playwright");
const mysql = require("mysql2");

const db = mysql.createConnection({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

db.connect(err => {
  if (err) {
    console.error("DB connection error:", err);
    return;
  }
  console.log("Connected to MySQL");
});

(async () => {
  db.query("SELECT * FROM episodes", async (err, results) => {
    if (err) {
      console.error("Query error:", err);
      return;
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    for (const episode of results) {
      console.log(`Scraping anime ${episode.animeId} | ${episode.episodeHref}`);

      try {
        await page.goto(episode.episodeHref, { waitUntil: "networkidle" });

        await page.waitForSelector("#episode-servers > li", { timeout: 10000 });

        const serverCount = await page.$$eval("#episode-servers > li", els => els.length);

        let serversLinks = [];

        for (let i = 0; i < serverCount; i++) {
          console.log(`Clicking server ${i + 1}`);

          const servers = await page.$$("#episode-servers > li");
          await servers[i].click();

          await page.waitForSelector("#iframe-container > iframe", { timeout: 10000 });

          const frameHandle = await page.$("#iframe-container > iframe");
          const frame = await frameHandle?.contentFrame();

          if (!frame) continue;
            // wait for iframe to actually render content
            await frame.waitForLoadState?.("networkidle").catch(() => {});
            await frame.waitForTimeout(2000)
          const playerSelector =
            "#PlayerDisplay > div.OptionsLangDisp > div > div > li";

          const hasList = await frame.$(playerSelector);

          if (hasList) {
            await frame.waitForSelector(playerSelector);

            const hasPlayer = await frame.$(playerSelector);

if (!hasPlayer) {
  console.log("Player not ready, waiting...");

  await frame.waitForTimeout(3000);

  const retry = await frame.$(playerSelector);

  if (!retry) {
    console.log("Still no player, skipping server");
    continue;
  }
}


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

const videoLink = await frame.$eval(videoSelector, video =>
  video.src || video.currentSrc || video.getAttribute("src")
).catch(() => null);

console.log("Video:", videoLink);
            serversLinks.push(videoLink);


          }
        }

        console.log("FINAL LINKS:", serversLinks);


        if (serversLinks.length > 0) {
        const values = serversLinks.map(link => [
            episode.id,   // or episode.animeId if you use that
            link,
            episode.animeId
        ]);

        const query = "INSERT INTO servers (episodeId, serverLink, animeId) VALUES ?";

        db.query(query, [values], (err) => {
            if (err) {
            console.error("Insert error:", err);
            } else {
            console.log(`Inserted ${values.length} links`);
            }
        });
        }



        // 👉 OPTIONAL: store in DB
        // db.query("UPDATE episodes SET links=? WHERE id=?", [
        //   JSON.stringify(serversLinks),
        //   episode.id
        // ]);

      } catch (error) {
        console.error("Scrape error:", episode.animeId, error.message);
      }
    }

    await browser.close();
    db.end();
  });
})();