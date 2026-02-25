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
const CT_BASE = "https://apiadvisor.climatempo.com.br/api/v1";
const CT_TOKEN = process.env.CLIMATEMPO_TOKEN || "";
let cachedLocaleId = process.env.CLIMATEMPO_LOCALE_ID || "";

const DEFAULT_CITY_NAME = "Agua Santa";
const DEFAULT_STATE = "RJ";

function mustToken() {
  if (!CT_TOKEN) {
    const e = new Error("Falta CLIMATEMPO_TOKEN nas variáveis de ambiente.");
    e.status = 500;
    throw e;
  }
}

async function ctFetchJson(url) {
  const r = await _fetch(url, { headers: { "User-Agent": "radar-operacional/1.0" } });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`ClimaTempo HTTP ${r.status}: ${text.slice(0, 200)}`);
    e.status = 502;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error("Resposta inválida (não-JSON) da ClimaTempo.");
    e.status = 502;
    throw e;
  }
}

async function resolveLocaleId({ name, state }) {
  if (cachedLocaleId) return cachedLocaleId;

  const url =
    `${CT_BASE}/locale/city?name=${encodeURIComponent(name)}&state=${encodeURIComponent(state)}&token=${encodeURIComponent(CT_TOKEN)}`;

  const arr = await ctFetchJson(url);

  const first = Array.isArray(arr) ? arr[0] : null;
  const id = first?.id;
  if (!id) {
    const e = new Error("Não achei locale id da cidade na ClimaTempo.");
    e.status = 404;
    throw e;
  }

  cachedLocaleId = String(id);
  return cachedLocaleId;
}

app.get("/weather", async (req, res) => {
  try {
    mustToken();

    const cityName = String(req.query.city || DEFAULT_CITY_NAME);
    const state = String(req.query.state || DEFAULT_STATE);

    const localeId = await resolveLocaleId({ name: cityName, state });

    const currentUrl =
      `${CT_BASE}/weather/locale/${encodeURIComponent(localeId)}/current?token=${encodeURIComponent(CT_TOKEN)}`;
    const current = await ctFetchJson(currentUrl);

    const daysUrl =
      `${CT_BASE}/forecast/locale/${encodeURIComponent(localeId)}/days/15?token=${encodeURIComponent(CT_TOKEN)}`;
    const forecast = await ctFetchJson(daysUrl);

    const day0 = forecast?.data?.[0] || null;

    const cond =
      current?.data?.condition ||
      current?.data?.text ||
      current?.data?.text_pt ||
      current?.data?.phrase ||
      day0?.text_phrase?.reduced ||
      day0?.text ||
      "—";

    const min = day0?.temperature?.min ?? day0?.temperature_min ?? null;
    const max = day0?.temperature?.max ?? day0?.temperature_max ?? null;

    const place =
      forecast?.name && forecast?.state
        ? `${forecast.name} • ${forecast.state}`
        : `Água Santa • RJ`;

    res.json({
      ok: true,
      place,
      cond,
      min,
      max,
      localeId,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Erro no /weather" });
  }
});

// ============================
// Start
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚨 RADAR API NOVA SUBIU — server.js ATUAL — porta", PORT));
