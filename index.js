const express = require("express");
const { chromium } = require("playwright");
const mysql = require("mysql2");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(cors());
const PORT = process.env.PORT || 3000;

// =====================
// DB (FIXED ORDER)
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
// SCRAPER LOCK
// =====================

// =====================
// SCRAPER
// =====================

app.get("/", (req, res) => {
  res.send("Welcome to server");
});




app.get("/api/animes/search", (req, res) => {
  const q = req.query.q;

  if (!q) {
    return res.status(400).json({ error: "Query is required" });
  }

  const sql = `
    SELECT id, title, animePoster, description, genres
    FROM animes
    WHERE title LIKE ?
    LIMIT 20
  `;

  db.query(sql, [`%${q}%`], (err, results) => {
    if (err) return res.status(500).json(err);

    res.json(results);
  });
});


app.get("/api/animes/all", (req, res) => {
  const sql = `
    SELECT id, title, animePoster, description, genres
    FROM animes
    ORDER BY id DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("DB error:", err);
      return res.status(500).json({
        success: false,
        message: "Database error",
      });
    }

    res.json({
      success: true,
      data: results,
    });
  });
});

app.get("/api/animes/:id", (req, res) => {
  const animeId = req.params.id;

  const animeQuery = `
    SELECT * FROM animes WHERE id = ?
  `;

  const episodesQuery = `
    SELECT id, animeId
    FROM episodes
    WHERE animeId = ?
    ORDER BY id ASC
  `;

  db.query(animeQuery, [animeId], (err, animeResult) => {
    if (err) return res.status(500).json(err);
    if (animeResult.length === 0)
      return res.status(404).json({ error: "Anime not found" });

    db.query(episodesQuery, [animeId], (err, episodesResult) => {
      if (err) return res.status(500).json(err);

      res.json({
        anime: animeResult[0],
        episodes: episodesResult,
      });
    });
  });
});

app.get("/api/episodes/:episodeId/servers", (req, res) => {
  const episodeId = req.params.episodeId;

  const sql = `
    SELECT id, serverLink
    FROM servers
    WHERE episodeId = ?
  `;

  db.query(sql, [episodeId], (err, results) => {
    if (err) return res.status(500).json(err);

    res.json(results);
  });
});


// =====================
// START SERVER
// =====================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
