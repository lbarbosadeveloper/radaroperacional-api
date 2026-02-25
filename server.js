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
// ============================
// ✅ WEATHER (Open-Meteo) com cache + retry
// ============================

const WX_DEFAULT = {
  place: "Água Santa • RJ",
  lat: -22.8776,
  lon: -43.3043,
};

let WEATHER_CACHE = null; // { ok:true, place, cond, min, max, updatedAt, stale? }

function codeToPt(code) {
  if (code === 0) return "Céu limpo";
  if (code === 1 || code === 2) return "Poucas nuvens";
  if (code === 3) return "Nublado";
  if (code === 45 || code === 48) return "Neblina";
  if ([51, 53, 55].includes(code)) return "Garoa";
  if ([61, 63, 65].includes(code)) return "Chuva";
  if ([80, 81, 82].includes(code)) return "Pancadas de chuva";
  if ([95, 96, 99].includes(code)) return "Tempestade";
  return "—";
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await _fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "radar-operacional/1.0" } });
  } finally {
    clearTimeout(t);
  }
}

async function getOpenMeteo({ lat, lon }) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&current=weather_code,temperature_2m` +
    `&daily=temperature_2m_min,temperature_2m_max` +
    `&timezone=America%2FSao_Paulo`;

  // 2 tentativas rápidas (pra quando dá timeout momentâneo)
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetchWithTimeout(url, 8000);
      const text = await r.text();

      if (!r.ok) {
        throw new Error(`Open-Meteo HTTP ${r.status}: ${text.slice(0, 140)}`);
      }

      const j = JSON.parse(text);

      const code = j?.current?.weather_code;
      const cond = codeToPt(code);
      const min = j?.daily?.temperature_2m_min?.[0] ?? null;
      const max = j?.daily?.temperature_2m_max?.[0] ?? null;

      if (min == null || max == null) throw new Error("Open-Meteo sem min/max no retorno.");

      return { cond, min, max };
    } catch (e) {
      lastErr = e;
      // pequena pausa antes de retry
      await new Promise((rr) => setTimeout(rr, 250));
    }
  }
  throw lastErr || new Error("Falha desconhecida Open-Meteo.");
}

app.get("/weather", async (req, res) => {
  try {
    const lat = Number(req.query.lat ?? WX_DEFAULT.lat);
    const lon = Number(req.query.lon ?? WX_DEFAULT.lon);
    const place = String(req.query.place || WX_DEFAULT.place);

    const data = await getOpenMeteo({ lat, lon });

    WEATHER_CACHE = {
      ok: true,
      place,
      cond: data.cond,
      min: data.min,
      max: data.max,
      updatedAt: new Date().toISOString(),
      stale: false,
    };

    return res.json(WEATHER_CACHE);
  } catch (e) {
    // ✅ Se falhar, mas temos cache, devolve cache "stale" (não some do painel)
    if (WEATHER_CACHE?.ok) {
      return res.json({ ...WEATHER_CACHE, stale: true, error: "Falha ao atualizar agora." });
    }

    // Sem cache ainda → devolve erro com detalhe (pra debug)
    return res.status(502).json({
      ok: false,
      error: "Falha ao obter clima (Open-Meteo).",
      details: String(e?.message || e).slice(0, 180),
    });
  }
});
// ============================
// Start
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚨 RADAR API NOVA SUBIU — server.js ATUAL — porta", PORT));


