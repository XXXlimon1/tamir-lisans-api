require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lisanslar (
      id SERIAL PRIMARY KEY,
      makine_id TEXT UNIQUE NOT NULL,
      musteri_adi TEXT NOT NULL,
      musteri_telefon TEXT,
      lisans_anahtari TEXT NOT NULL,
      son_gecerlilik DATE NOT NULL,
      aktif BOOLEAN DEFAULT true,
      olusturma_tarihi TIMESTAMPTZ DEFAULT NOW(),
      notlar TEXT
    )
  `);
  console.log("✅ Veritabanı hazır");
}

module.exports = { pool, init };
