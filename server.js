require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const { pool, init } = require("./db");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const GIZLI_ANAHTAR = process.env.LISANS_GIZLI_ANAHTAR || "TamirOtomasyon_Gizli_2024";

// ─── SWAGGER ────────────────────────────────────────────────
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Tamir Otomasyon — Lisans API",
      version: "1.0.0",
      description: "Lisans doğrulama ve yönetim servisi. Admin endpointleri x-api-key gerektirir."
    },
    servers: [
      { url: "https://tamir-lisans-api.onrender.com", description: "Production" },
      { url: "http://localhost:4000", description: "Lokal" }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" }
      }
    }
  },
  apis: ["./server.js"]
};
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerDocs, {
  customSiteTitle: "Tamir Lisans API",
  customCss: ".swagger-ui .topbar { background: #1a1a2e; }"
}));

// ─── YARDIMCI ───────────────────────────────────────────────
function lisansUret(makineId, sonGecerlilik) {
  const veri = `${makineId}:${sonGecerlilik}:${GIZLI_ANAHTAR}`;
  const hash = crypto.createHash("sha256").update(veri).digest("hex").substring(0, 16).toUpperCase();
  return `TAM-${hash.substring(0,4)}-${hash.substring(4,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}`;
}

function adminKontrol(req, res) {
  if (req.headers["x-api-key"] !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ hata: "Yetkisiz" });
    return false;
  }
  return true;
}

// ─── ENDPOİNTLER ────────────────────────────────────────────

/**
 * @swagger
 * /saglik:
 *   get:
 *     summary: Servis sağlık kontrolü
 *     responses:
 *       200:
 *         description: Çalışıyor
 */
app.get("/saglik", async (req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*) FROM lisanslar");
  res.json({ durum: "çalışıyor", lisans_sayisi: parseInt(rows[0].count) });
});

/**
 * @swagger
 * /lisans/dogrula:
 *   post:
 *     summary: Lisans doğrula (uygulama her açılışta çağırır)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               makine_id: { type: string }
 *               lisans_anahtari: { type: string }
 *     responses:
 *       200:
 *         description: Doğrulama sonucu
 */
app.post("/lisans/dogrula", async (req, res) => {
  const { makine_id, lisans_anahtari } = req.body;
  if (!makine_id || !lisans_anahtari)
    return res.status(400).json({ gecerli: false, mesaj: "Eksik parametre" });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM lisanslar WHERE makine_id = $1", [makine_id]
    );

    if (!rows.length)
      return res.json({ gecerli: false, mesaj: "Lisans bulunamadı" });

    const kayit = rows[0];

    if (!kayit.aktif)
      return res.json({ gecerli: false, mesaj: "Lisans iptal edildi" });

    if (kayit.lisans_anahtari !== lisans_anahtari)
      return res.json({ gecerli: false, mesaj: "Geçersiz lisans anahtarı" });

    const bugun = new Date().toISOString().split("T")[0];
    const sonGecerlilik = kayit.son_gecerlilik.toISOString().split("T")[0];

    if (bugun > sonGecerlilik)
      return res.json({ gecerli: false, mesaj: `Lisans süresi doldu (${sonGecerlilik})` });

    const kalan = Math.ceil((new Date(sonGecerlilik) - new Date()) / (1000 * 60 * 60 * 24));

    res.json({
      gecerli: true,
      mesaj: "Lisans geçerli",
      son_gecerlilik: sonGecerlilik,
      kalan_gun: kalan,
      musteri_adi: kayit.musteri_adi
    });
  } catch (err) {
    res.status(500).json({ gecerli: false, mesaj: "Sunucu hatası: " + err.message });
  }
});

/**
 * @swagger
 * /lisans/uret:
 *   post:
 *     summary: Yeni lisans üret
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               makine_id: { type: string }
 *               musteri_adi: { type: string }
 *               musteri_telefon: { type: string }
 *               ay: { type: integer }
 *               notlar: { type: string }
 *     responses:
 *       200:
 *         description: Lisans üretildi
 */
app.post("/lisans/uret", async (req, res) => {
  if (!adminKontrol(req, res)) return;

  const { makine_id, musteri_adi, musteri_telefon, ay, notlar } = req.body;
  if (!makine_id || !musteri_adi || !ay)
    return res.status(400).json({ hata: "makine_id, musteri_adi ve ay zorunlu" });

  try {
    const sonGecerlilik = new Date();
    sonGecerlilik.setMonth(sonGecerlilik.getMonth() + parseInt(ay));
    const sonGecerlilikStr = sonGecerlilik.toISOString().split("T")[0];
    const anahtar = lisansUret(makine_id, sonGecerlilikStr);

    await pool.query(`
      INSERT INTO lisanslar (makine_id, musteri_adi, musteri_telefon, lisans_anahtari, son_gecerlilik, notlar)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (makine_id) DO UPDATE SET
        musteri_adi = $2, musteri_telefon = $3,
        lisans_anahtari = $4, son_gecerlilik = $5,
        notlar = $6, aktif = true
    `, [makine_id, musteri_adi, musteri_telefon || null, anahtar, sonGecerlilikStr, notlar || null]);

    res.json({ anahtar, son_gecerlilik: sonGecerlilikStr, musteri_adi });
  } catch (err) {
    res.status(500).json({ hata: err.message });
  }
});

/**
 * @swagger
 * /lisans/iptal:
 *   post:
 *     summary: Lisans iptal et
 *     security:
 *       - ApiKeyAuth: []
 */
app.post("/lisans/iptal", async (req, res) => {
  if (!adminKontrol(req, res)) return;
  const { makine_id } = req.body;
  try {
    const { rowCount } = await pool.query(
      "UPDATE lisanslar SET aktif = false WHERE makine_id = $1", [makine_id]
    );
    if (!rowCount) return res.status(404).json({ hata: "Lisans bulunamadı" });
    res.json({ mesaj: "Lisans iptal edildi" });
  } catch (err) { res.status(500).json({ hata: err.message }); }
});

/**
 * @swagger
 * /lisans/liste:
 *   get:
 *     summary: Tüm lisansları listele
 *     security:
 *       - ApiKeyAuth: []
 */
app.get("/lisans/liste", async (req, res) => {
  if (!adminKontrol(req, res)) return;
  try {
    const { rows } = await pool.query("SELECT * FROM lisanslar ORDER BY olusturma_tarihi DESC");
    res.json(rows);
  } catch (err) { res.status(500).json({ hata: err.message }); }
});

/**
 * @swagger
 * /lisans/yenile:
 *   post:
 *     summary: Mevcut lisansı uzat
 *     security:
 *       - ApiKeyAuth: []
 */
app.post("/lisans/yenile", async (req, res) => {
  if (!adminKontrol(req, res)) return;
  const { makine_id, ay } = req.body;
  if (!makine_id || !ay) return res.status(400).json({ hata: "makine_id ve ay zorunlu" });

  try {
    const { rows } = await pool.query("SELECT * FROM lisanslar WHERE makine_id = $1", [makine_id]);
    if (!rows.length) return res.status(404).json({ hata: "Lisans bulunamadı" });

    const mevcut = rows[0];
    // Mevcut bitiş tarihinden uzat (dolmamışsa), dolmuşsa bugünden uzat
    const baslangic = new Date(mevcut.son_gecerlilik) > new Date()
      ? new Date(mevcut.son_gecerlilik)
      : new Date();
    baslangic.setMonth(baslangic.getMonth() + parseInt(ay));
    const yeniTarih = baslangic.toISOString().split("T")[0];
    const yeniAnahtar = lisansUret(makine_id, yeniTarih);

    await pool.query(
      "UPDATE lisanslar SET son_gecerlilik = $1, lisans_anahtari = $2, aktif = true WHERE makine_id = $3",
      [yeniTarih, yeniAnahtar, makine_id]
    );

    res.json({ anahtar: yeniAnahtar, son_gecerlilik: yeniTarih, mesaj: "Lisans yenilendi" });
  } catch (err) { res.status(500).json({ hata: err.message }); }
});

// ─── BAŞLAT ─────────────────────────────────────────────────
init().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Lisans API çalışıyor: http://localhost:${PORT}`);
    console.log(`📋 Swagger UI: http://localhost:${PORT}/swagger`);
  });
}).catch(err => {
  console.error("Veritabanı bağlantısı kurulamadı:", err.message);
  process.exit(1);
});
