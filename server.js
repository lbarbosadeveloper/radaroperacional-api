// server.js (API para Render / Railway)
// - GET /health
// - GET /search?q=...&sites=dom1,dom2
//
// Recomendado: usar esse server separado do GitHub Pages (Pages = front estático)

import express from "express";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ============================
// ✅ CORS (GitHub Pages + local)
// ============================
const ALLOWED_ORIGINS = new Set([
  "https://lbarbosadeveloper.github.io", // seu GitHub Pages (domínio)
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

app.use(
  cors({
    origin(origin, cb) {
      // requests sem origin (curl/postman) passam
      if (!origin) return cb(null, true);

      // libera o domínio do pages + variações de porta (local)
      if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);

      // opcional: liberar qualquer subpath do github.io (origin vem só domínio)
      // se quiser liberar qualquer usuário no github.io, use:
      // if (origin.endsWith(".github.io")) return cb(null, true);

      return cb(new Error("CORS bloqueado: " + origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ============================
// Health check (pra testar no browser)
// ============================
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ============================
// Helpers RSS (sem libs)
// ============================
function decodeEntities(str = "") {
  let s = String(str);

  s = s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");

  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return s;
}

function stripTags(html = "") {
  let s = String(html || "");
  for (let i = 0; i < 3; i++) s = decodeEntities(s);

  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function pickAttrTag(block, tag, attrName) {
  const re = new RegExp(`<${tag}\\b[^>]*${attrName}="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return { attr: m[1]?.trim() || "", text: (m[2] || "").trim() };
}

function getHostSafe(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function parseRss(xmlText = "") {
  const xml = String(xmlText);

  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];

    const title = decodeEntities(pickTag(itemXml, "title"));
    const link = decodeEntities(pickTag(itemXml, "link"));
    const pubDateRaw = decodeEntities(pickTag(itemXml, "pubDate"));

    const sourceObj = pickAttrTag(itemXml, "source", "url");
    const sourceName = sourceObj ? decodeEntities(sourceObj.text) : "";
    const sourceUrl = sourceObj ? decodeEntities(sourceObj.attr) : "";

    const descRaw = pickTag(itemXml, "description");
    const snippet = stripTags(descRaw);

    let publishedAt = null;
    if (pubDateRaw) {
      const d = new Date(pubDateRaw);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    items.push({
      title,
      url: link, // muitas vezes news.google.com
      snippet,
      source: sourceName || (sourceUrl ? sourceUrl : ""),
      publishedAt,
      publisherUrl: "",
      publisherDomain: "",
    });
  }

  return items;
}

function normalizeDomainList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) =>
      d
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/.*$/, "")
        .toLowerCase()
    );
}

function buildGoogleNewsQuery(keyword, sites = []) {
  const k = String(keyword || "").trim();
  if (!k) return "";
  if (!sites.length) return k;

  const sitePart = sites.map((d) => `site:${d}`).join(" OR ");
  return `(${k}) (${sitePart})`;
}

// ============================
// ✅ Resolver redirect do Google News -> Publisher real
// ============================
function isGoogleNewsHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "news.google.com" || h.endsWith(".news.google.com");
}

function isGoogleHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "google.com" || h.endsWith(".google.com");
}

async function resolvePublisherFromGoogleNewsUrl(gnUrl, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(gnUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (RadarOperacional; Node)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const finalUrl = r.url || "";
    const host = getHostSafe(finalUrl);

    if (!finalUrl) return { publisherUrl: "", publisherDomain: "" };
    if (isGoogleNewsHost(host) || isGoogleHost(host)) return { publisherUrl: "", publisherDomain: "" };

    return { publisherUrl: finalUrl, publisherDomain: host };
  } catch {
    return { publisherUrl: "", publisherDomain: "" };
  } finally {
    clearTimeout(t);
  }
}

// pool simples de concorrência
async function mapPool(items, concurrency, mapper) {
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await mapper(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return out;
}

// ============================
// /search
// ============================
app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ results: [] });

    const sites = normalizeDomainList(req.query.sites);
    const query = buildGoogleNewsQuery(q, sites);

    const rssUrl =
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
      `&hl=pt-BR&gl=BR`;

    const r = await fetch(rssUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (RadarOperacional; RSS)",
        Accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!r.ok) {
      console.error("Google RSS HTTP", r.status);
      return res.status(502).json({ results: [], error: "rss_http_" + r.status });
    }

    const xml = await r.text();
    const items = parseRss(xml).filter((it) => it.url && it.title).slice(0, 10);

    // Enriquecer publisherUrl/publisherDomain
    const enriched = await mapPool(items, 3, async (it) => {
      const host = getHostSafe(it.url);
      if (isGoogleNewsHost(host)) {
        const resolved = await resolvePublisherFromGoogleNewsUrl(it.url);
        return { ...it, ...resolved };
      }
      return { ...it, publisherUrl: it.url, publisherDomain: getHostSafe(it.url) };
    });

    const results = enriched.map((it) => ({
      title: it.title,
      snippet: it.snippet,
      source: it.source,
      url: it.url,
      publishedAt: it.publishedAt,
      publisherUrl: it.publisherUrl,
      publisherDomain: it.publisherDomain,
    }));

    return res.json({ results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ results: [], error: "search_failed" });
  }
});

// Root opcional
app.get("/", (req, res) => {
  res.send("Radar Operacional API ok. Use /health e /search.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API online na porta ${PORT}`);
});
