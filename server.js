// server.js
import express from "express";
import cors from "cors";
import { XMLParser } from "fast-xml-parser";

// ✅ Fallback pro fetch (Render/Node antigo)
let _fetch = globalThis.fetch;
if (!_fetch) {
  const mod = await import("node-fetch");
  _fetch = mod.default;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============================
// ✅ CORS
// ============================
const ALLOWED_ORIGINS = new Set([
  "https://lbarbosadeveloper.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

// ============================
// Health
// ============================
app.get("/health", (_req, res) => res.json({ ok: true }));

// ============================
// ✅ Estágio (cor/estagio)
// Você pode setar ESTAGIO=1..5 no Render (Environment).
// ============================
app.get("/cor/estagio", (_req, res) => {
  const estagio = Math.max(1, Math.min(5, Number(process.env.ESTAGIO || 2)));
  res.json({ ok: true, estagio });
});

// ============================
// ✅ Google News RSS /search
// GET /search?q=...&date=YYYY-MM-DD&sites=dom1,dom2
// ============================
function stripHtml(s = "") {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u = "") {
  const s = String(u || "").trim();
  if (!s) return "";
  // Google News RSS às vezes manda link direto, às vezes manda tracking. Mantém o que vier.
  return s;
}

function buildGoogleNewsRssUrl({ q, sites = [] }) {
  const base = "https://news.google.com/rss/search";
  const ceid = "BR:pt-419";
  const hl = "pt-BR";
  const gl = "BR";

  // Monta filtro site: (site:a OR site:b)
  let query = String(q || "").trim();
  if (sites.length) {
    const siteExpr = sites.map((d) => `site:${d}`).join(" OR ");
    query = query ? `(${query}) (${siteExpr})` : `(${siteExpr})`;
  }

  const url = new URL(base);
  url.searchParams.set("q", query || "trânsito RJ");
  url.searchParams.set("hl", hl);
  url.searchParams.set("gl", gl);
  url.searchParams.set("ceid", ceid);
  return url.toString();
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
});

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const sitesRaw = String(req.query.sites || "").trim();
    const sites = sitesRaw
      ? sitesRaw.split(",").map((s) => s.trim().replace(/^www\./, "")).filter(Boolean)
      : [];

    const rssUrl = buildGoogleNewsRssUrl({ q, sites });

    const r = await _fetch(rssUrl, {
      headers: {
        "User-Agent": "radar-operacional/1.0",
        "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      },
    });

    const xml = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `Google News RSS HTTP ${r.status}`,
        details: xml.slice(0, 200),
      });
    }

    const data = xmlParser.parse(xml);
    const items = data?.rss?.channel?.item || [];
    const arr = Array.isArray(items) ? items : [items].filter(Boolean);

    const results = arr.slice(0, 50).map((it) => {
      const title = String(it?.title || "").trim();
      const url = normalizeUrl(it?.link || "");
      const publishedAt = it?.pubDate ? new Date(it.pubDate).toISOString() : null;

      // No RSS, source geralmente vem como: source: { "#text": "G1", url: "..." }
      let source = "Fonte";
      if (typeof it?.source === "string") source = it.source;
      else if (it?.source && typeof it.source === "object") source = it.source["#text"] || it.source.text || "Fonte";

      const snippet = stripHtml(it?.description || "");

      return {
        title,
        url,
        publishedAt,
        source,
        snippet,
        publisherUrl: (it?.source && typeof it.source === "object" && it.source.url) ? String(it.source.url) : "",
        publisherDomain: "",
      };
    });

    res.json({ ok: true, results, rssUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Erro no /search" });
  }
});

// ============================
// ✅ CLIMATEMPO /weather
// ============================
// ============================
// ✅ WEATHER (sem token) — Open-Meteo
// Mantém a mesma resposta: { ok, place, cond, min, max, updatedAt }
// ============================

// Água Santa / RJ (aprox) — ajuste se quiser
const WX_DEFAULT = {
  place: "Água Santa • RJ",
  lat: -22.8776,
  lon: -43.3043,
};

function codeToPt(code) {
  // WMO weather codes (bem resumido)
  if (code === 0) return "Céu limpo";
  if (code === 1 || code === 2) return "Poucas nuvens";
  if (code === 3) return "Nublado";
  if (code === 45 || code === 48) return "Neblina";
  if ([51, 53, 55].includes(code)) return "Garoa";
  if ([56, 57].includes(code)) return "Garoa congelante";
  if ([61, 63, 65].includes(code)) return "Chuva";
  if ([66, 67].includes(code)) return "Chuva congelante";
  if ([71, 73, 75, 77].includes(code)) return "Neve";
  if ([80, 81, 82].includes(code)) return "Pancadas de chuva";
  if ([85, 86].includes(code)) return "Pancadas de neve";
  if ([95, 96, 99].includes(code)) return "Tempestade";
  return "—";
}

app.get("/weather", async (req, res) => {
  try {
    const lat = Number(req.query.lat ?? WX_DEFAULT.lat);
    const lon = Number(req.query.lon ?? WX_DEFAULT.lon);
    const place = String(req.query.place || WX_DEFAULT.place);

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=weather_code,temperature_2m` +
      `&daily=temperature_2m_min,temperature_2m_max` +
      `&timezone=America%2FSao_Paulo`;

    const r = await _fetch(url, { headers: { "User-Agent": "radar-operacional/1.0" } });
    const j = await r.json().catch(() => null);

    if (!r.ok || !j) {
      return res.status(502).json({ ok: false, error: "Falha ao obter clima (Open-Meteo)." });
    }

    const code = j?.current?.weather_code;
    const cond = codeToPt(code);

    const min = j?.daily?.temperature_2m_min?.[0] ?? null;
    const max = j?.daily?.temperature_2m_max?.[0] ?? null;

    res.json({
      ok: true,
      place,
      cond,
      min,
      max,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Erro no /weather" });
  }
});

// ============================
// Start
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚨 RADAR API NOVA SUBIU — server.js ATUAL — porta", PORT));

