// server.js
import express from "express";
import cors from "cors";

// ✅ Fallback pro fetch (resolve “clima não aparece” em Node/Render quando fetch não existe)
// Se seu Node já tiver fetch, isso não atrapalha.
let _fetch = globalThis.fetch;
if (!_fetch) {
  const mod = await import("node-fetch");
  _fetch = mod.default;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const ALLOWED_ORIGINS = new Set([
  "https://lbarbosadeveloper.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
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

app.get("/_whoami", (_req, res) => {
  res.json({
    ok: true,
    build: "RADAR-WHOAMI-001",
    time: new Date().toISOString()
  });
});


// ============================
// ✅ CLIMATEMPO /weather
// ============================
const CT_BASE = "https://apiadvisor.climatempo.com.br/api/v1";
const CT_TOKEN = process.env.CLIMATEMPO_TOKEN || "";
let cachedLocaleId = process.env.CLIMATEMPO_LOCALE_ID || "";

// você pode trocar isso quando quiser
const DEFAULT_CITY_NAME = "Agua Santa"; // sem acento costuma ser mais safe
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

  // normalmente vem array de cidades
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

    // 1) clima atual
    const currentUrl =
      `${CT_BASE}/weather/locale/${encodeURIComponent(localeId)}/current?token=${encodeURIComponent(CT_TOKEN)}`;
    const current = await ctFetchJson(currentUrl);

    // 2) previsão 15 dias (pra pegar min/max do dia 0)
    const daysUrl =
      `${CT_BASE}/forecast/locale/${encodeURIComponent(localeId)}/days/15?token=${encodeURIComponent(CT_TOKEN)}`;
    const forecast = await ctFetchJson(daysUrl);

    const day0 = forecast?.data?.[0] || null;

    // pega o melhor “texto de condição” disponível (ClimaTempo varia chaves)
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
// ⚠️ Aqui ficam as suas outras rotas (/search, /cor/estagio, etc.)
// (mantém como já estava no seu projeto)
// ============================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚨 RADAR API NOVA SUBIU — server.js ATUAL — porta", PORT));



