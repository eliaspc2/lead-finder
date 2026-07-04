const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawnSync } = require("child_process");

const RUN_DIR = process.env.LEAD_WORKER_RUN_DIR || process.cwd();
const REQUEST_FILE = process.env.LEAD_WORKER_REQUEST_FILE || path.join(RUN_DIR, "request.json");
const RESPONSE_FILE = process.env.LEAD_WORKER_RESPONSE_FILE || path.join(RUN_DIR, "response.json");
const LOG_FILE = process.env.LEAD_WORKER_LOG_FILE || path.join(RUN_DIR, "worker.log");
const OUTPUT_FILE = process.env.LEAD_WORKER_OUTPUT_FILE || path.join(RUN_DIR, "leads.csv");
const SOURCE_TYPE = String(process.env.LEAD_WORKER_SOURCE_TYPE || "").trim() || "free";
const SOURCE_LABEL = String(process.env.LEAD_WORKER_SOURCE_LABEL || SOURCE_TYPE).trim();
const PYTHON_ENTRY = path.join(__dirname, "scrape_pai.py");
const APP_DIR = path.resolve(__dirname, "..");
const SHARED_RUN_DIR = path.resolve(RUN_DIR, "..");
const SEARCH_THROTTLE_FILE = path.join(SHARED_RUN_DIR, ".search-throttle.json");
const SEARCH_THROTTLE_LOCK = path.join(SHARED_RUN_DIR, ".search-throttle.lock");
const DEFAULT_COLUMNS = "Nome;Pagina web;Redes sociais;Email;Telefone;Localidade;Distrito;Fontes consultadas;Observacoes";
const PROVIDER_INTERVAL_MS = {
  google: 18000,
  brave: 9000,
  duckduckgo: 9000,
  yahoo: 6500,
  qwant: 4500,
  mojeek: 4500,
  bing: 4500,
};
const PROVIDER_COOLDOWN_MS = {
  google: 5 * 60 * 1000,
  brave: 3 * 60 * 1000,
  duckduckgo: 60 * 1000,
  yahoo: 60 * 1000,
};

function nowStamp() {
  return new Date().toLocaleTimeString("pt-PT", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function log(message) {
  const line = `[${nowStamp()}] ${message}`;
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  process.stdout.write(`${line}\n`);
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock(lockPath, task) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    let handle = null;
    try {
      handle = fs.openSync(lockPath, "wx");
      return await task();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await sleep(75 + Math.floor(Math.random() * 75));
    } finally {
      if (handle !== null) {
        fs.closeSync(handle);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock already gone; another cleanup won the race.
        }
      }
    }
  }
  throw new Error("Throttle lock timeout");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[;\n\r"]/u.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function splitWords(value) {
  return String(value || "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeLeadType(leadType) {
  return String(leadType || "").trim().toLowerCase();
}

function keywordVariants(leadType) {
  const normalized = normalizeLeadType(leadType);
  if (/barbear|barber/.test(normalized)) {
    return ["barbearia", "barber shop", "barbershop"];
  }
  if (/talh|carn/.test(normalized)) {
    return ["talho", "talhos", "butcher", "butcher shop"];
  }
  if (/padar|bolo|p[aã]o/.test(normalized)) {
    return ["padaria", "pastelaria", "bolos", "pao", "pão"];
  }
  if (/haccp/.test(normalized)) {
    return ["haccp", "consultoria haccp", "implementação haccp"];
  }
  if (/cozinha/.test(normalized)) {
    return ["cozinha regional", "cozinha tradicional", "restaurante regional"];
  }
  if (/transforma.*carne|carne/.test(normalized)) {
    return ["transformação de carne", "indústria de carne", "processamento de carne"];
  }
  return splitWords(leadType).length ? [leadType] : ["leads"];
}

function buildQueries(request) {
  const leadType = request.leadType || request.objective || "leads";
  const geography = String(request.geography || "Portugal").trim();
  const variants = keywordVariants(leadType);
  const queries = [];

  for (const variant of variants) {
    queries.push(`${variant} ${geography}`);
    queries.push(`${variant} ${geography} telefone email`);
    queries.push(`${variant} ${geography} website`);
  }

  if (SOURCE_TYPE === "social") {
    for (const variant of variants) {
      queries.push(`site:facebook.com ${variant} ${geography}`);
      queries.push(`site:instagram.com ${variant} ${geography}`);
    }
  } else if (SOURCE_TYPE === "maps") {
    for (const variant of variants) {
      queries.push(`site:google.com/maps ${variant} ${geography}`);
      queries.push(`site:google.pt/maps ${variant} ${geography}`);
    }
  } else if (SOURCE_TYPE === "directories") {
    for (const variant of variants) {
      queries.push(`site:pai.pt ${variant} ${geography}`);
      queries.push(`site:hotfrog.pt ${variant} ${geography}`);
      queries.push(`site:cylex.pt ${variant} ${geography}`);
      queries.push(`site:tuugo.pt ${variant} ${geography}`);
      queries.push(`site:misterwhat.pt ${variant} ${geography}`);
      queries.push(`site:infobel.com ${variant} ${geography}`);
    }
  } else if (SOURCE_TYPE === "free") {
    for (const variant of variants) {
      queries.push(`${variant} ${geography} contacto`);
      queries.push(`${variant} ${geography} redes sociais`);
      queries.push(`${variant} ${geography} diretório`);
    }
  }

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

function slugifySegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function directSeedUrls(request) {
  const leadType = normalizeLeadType(request.leadType || request.objective || "");
  const geography = String(request.geography || "").trim();
  const citySlug = slugifySegment(geography);
  const seeds = [];

  if (citySlug && /barbear|barber/.test(leadType)) {
    seeds.push(`https://ondecortar.pt/cidades/${citySlug}/`);
    seeds.push(`https://www.fresha.com/lp/pt/bt/barbershops/in/pt-${citySlug}`);
    seeds.push(`https://www.fresha.com/lp/en/bt/barbershops/in/pt-${citySlug}`);
    seeds.push(`https://booksy.com/pt-pt/s/barbearia/${encodeURIComponent(geography)}`);
    seeds.push(`https://www.agendoor.com/pt/explore/portugal/${citySlug}`);
  }

  if (citySlug && /talh|carn/.test(leadType)) {
    seeds.push(`https://www.pai.pt/searches?search%5Bquery%5D=talhos&search%5Blocation%5D=${encodeURIComponent(geography)}`);
  }

  return uniqueUrls(seeds);
}

function providerSearchUrl(provider, query) {
  const encoded = encodeURIComponent(query);
  switch (provider) {
    case "google":
      return `https://www.google.com/search?hl=pt-PT&gl=pt&num=10&q=${encoded}`;
    case "bing":
      return `https://www.bing.com/search?cc=pt&setlang=pt-PT&count=10&q=${encoded}`;
    case "duckduckgo":
      return `https://lite.duckduckgo.com/lite/?q=${encoded}`;
    case "yahoo":
      return `https://search.yahoo.com/search?p=${encoded}`;
    case "brave":
      return `https://search.brave.com/search?q=${encoded}&source=web`;
    case "mojeek":
      return `https://www.mojeek.com/search?q=${encoded}`;
    case "qwant":
      return `https://www.qwant.com/?q=${encoded}&t=web`;
    default:
      return "";
  }
}

function providersForSource() {
  const broad = ["bing", "yahoo", "qwant", "mojeek", "brave", "duckduckgo", "google"];
  if (SOURCE_TYPE === "maps") return ["bing", "qwant", "yahoo", "brave", "google", "duckduckgo"];
  if (SOURCE_TYPE === "social") return ["yahoo", "brave", "bing", "qwant", "google", "duckduckgo"];
  if (SOURCE_TYPE === "directories") return ["mojeek", "bing", "qwant", "yahoo", "brave", "google", "duckduckgo"];
  return broad;
}

function providerInitialDelay(provider) {
  const sourceOffset = {
    search: 0,
    maps: 1400,
    social: 2800,
    directories: 4200,
    free: 5600,
  }[SOURCE_TYPE] || 0;
  const providerOffset = {
    bing: 0,
    yahoo: 500,
    qwant: 1000,
    mojeek: 1500,
    brave: 2000,
    google: 2500,
    duckduckgo: 3000,
  }[provider] || 0;
  return sourceOffset + providerOffset;
}

async function waitForProviderTurn(provider) {
  const interval = PROVIDER_INTERVAL_MS[provider] || 5000;
  await sleep(providerInitialDelay(provider));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const turn = await withFileLock(SEARCH_THROTTLE_LOCK, async () => {
      const now = Date.now();
      const throttle = readJson(SEARCH_THROTTLE_FILE, {});
      const cooldowns = throttle.cooldowns || {};
      const cooldownUntil = Number(cooldowns[provider] || 0);
      if (cooldownUntil > now) {
        return { ready: false, cooldown: true, waitMs: cooldownUntil - now };
      }
      const last = Number(throttle[provider] || 0);
      const remaining = Math.max(0, interval - (now - last));
      if (remaining <= 0) {
        throttle[provider] = now;
        writeJson(SEARCH_THROTTLE_FILE, throttle);
      }
      return { ready: remaining <= 0, cooldown: false, waitMs: remaining };
    });
    if (turn.cooldown) {
      log(`${SOURCE_LABEL}: ${provider} em pausa temporária por bloqueio anterior`);
      return false;
    }
    if (turn.ready) {
      return true;
    }
    await sleep(turn.waitMs + 250);
  }
  return false;
}

function isTemporaryProviderBlock(error) {
  const message = String(error?.message || error || "");
  return /HTTP 429/i.test(message);
}

async function pauseProviderAfterError(provider, error) {
  if (!isTemporaryProviderBlock(error)) return;
  const cooldown = PROVIDER_COOLDOWN_MS[provider] || 2 * 60 * 1000;
  await withFileLock(SEARCH_THROTTLE_LOCK, async () => {
    const throttle = readJson(SEARCH_THROTTLE_FILE, {});
    throttle.cooldowns = throttle.cooldowns || {};
    throttle.cooldowns[provider] = Math.max(Number(throttle.cooldowns[provider] || 0), Date.now() + cooldown);
    writeJson(SEARCH_THROTTLE_FILE, throttle);
  });
}

function decodeMaybeUrl(text) {
  try {
    return decodeURIComponent(String(text || "").replace(/\+/g, "%20"));
  } catch {
    return String(text || "");
  }
}

function cleanUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, "https://example.com");
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      const target = url.searchParams.get("q") || url.searchParams.get("url") || url.searchParams.get("uddg");
      return target ? cleanUrl(target) : "";
    }
    if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      return target ? cleanUrl(target) : "";
    }
    if (url.hostname === "bing.com" && url.pathname === "/aclick") {
      const target = url.searchParams.get("u");
      return target ? cleanUrl(target) : "";
    }
    if (url.hostname.includes("yahoo.") && url.pathname.includes("/RU=")) {
      const match = url.pathname.match(/\/RU=([^/]+)/i);
      return match ? cleanUrl(decodeMaybeUrl(match[1])) : "";
    }
    if (url.hostname.includes("google.") && url.pathname === "/search") return "";
    if (url.hostname.includes("bing.com") && url.pathname === "/search") return "";
    if (url.hostname.includes("duckduckgo.com") && url.pathname === "/html/") return "";
    if (url.hostname.includes("search.brave.com") && url.pathname === "/search") return "";
    if (url.hostname.includes("mojeek.com") && url.pathname === "/search") return "";
    if (url.hostname.includes("qwant.com") && url.pathname === "/") return "";
    return url.toString();
  } catch {
    return text;
  }
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const url = cleanUrl(raw);
    if (!url) continue;
    const lowered = url.toLowerCase();
    if (seen.has(lowered)) continue;
    if (/javascript:|mailto:|tel:/i.test(lowered)) continue;
    if (/google\.(?:com|pt)\/search/i.test(lowered)) continue;
    if (/bing\.com\/search/i.test(lowered)) continue;
    if (/search\.yahoo\.com\/search/i.test(lowered)) continue;
    if (/search\.brave\.com\/search/i.test(lowered)) continue;
    if (/mojeek\.com\/search/i.test(lowered)) continue;
    if (/qwant\.com\/\?q=/i.test(lowered)) continue;
    if (/\/\/(?:r|th|www)\.bing\.com\//i.test(lowered)) continue;
    if (/\/\/(?:www\.)?microsoft\.com\//i.test(lowered)) continue;
    if (/\/fd\/ls\//i.test(lowered)) continue;
    if (/duckduckgo\.com\/html/i.test(lowered)) continue;
    seen.add(lowered);
    out.push(url);
  }
  return out;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "accept-language": "pt-PT,pt;q=0.9,en;q=0.8",
        ...(options.headers || {}),
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url, retries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 35000);
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

function htmlDecode(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html) {
  return htmlDecode(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractGoogleSearchUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/href="\/url\?q=([^"&]+)[^"]*"/g)) {
    urls.push(decodeMaybeUrl(match[1]));
  }
  return urls;
}

function extractBingSearchUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/<li class="b_algo"[\s\S]*?<h2>\s*<a href="([^"]+)"/gi)) {
    urls.push(match[1]);
  }
  return urls;
}

function extractDuckDuckGoSearchUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/uddg=([^&"]+)/g)) {
    urls.push(decodeMaybeUrl(match[1]));
  }
  for (const match of html.matchAll(/class="result__a"[^>]+href="([^"]+)"/gi)) {
    urls.push(match[1]);
  }
  return urls;
}

function extractYahooSearchUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/<a[^>]+class="[^"]*\bac-algo\b[^"]*"[^>]+href="([^"]+)"/gi)) {
    urls.push(match[1]);
  }
  for (const match of html.matchAll(/href="([^"]*\/RU=[^"]+)"/gi)) {
    urls.push(match[1]);
  }
  return urls;
}

function extractGenericSearchUrls(html) {
  const urls = [];
  for (const match of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"/gi)) {
    const href = htmlDecode(match[1]);
    try {
      if (/google|bing|duckduckgo|yahoo|brave|mojeek|qwant/i.test(new URL(href).hostname)) continue;
      urls.push(href);
    } catch {
      continue;
    }
  }
  return urls;
}

function friendlySearchError(error) {
  const message = String(error?.message || error || "");
  if (/HTTP 429/i.test(message)) return "motor bloqueou temporariamente (429)";
  if (/HTTP 403/i.test(message)) return "motor sem acesso publico (403)";
  return message;
}

async function searchQuery(query) {
  const providers = providersForSource();
  const providerRuns = providers.map(async (provider) => {
    const searchUrl = providerSearchUrl(provider, query);
    if (!searchUrl) return [];
    try {
      const ready = await waitForProviderTurn(provider);
      if (!ready) return [];
      const html = await fetchHtml(searchUrl, 2);
      const found =
        provider === "google"
          ? extractGoogleSearchUrls(html)
          : provider === "bing"
            ? extractBingSearchUrls(html)
            : provider === "duckduckgo"
              ? extractDuckDuckGoSearchUrls(html)
              : provider === "yahoo"
                ? extractYahooSearchUrls(html)
                : extractGenericSearchUrls(html);
      if (found.length) {
        log(`${SOURCE_LABEL}: ${provider} devolveu ${found.length} URLs para "${query}"`);
      }
      return found;
    } catch (error) {
      await pauseProviderAfterError(provider, error);
      log(`${SOURCE_LABEL}: sem resultados em ${provider} para "${query}" -> ${friendlySearchError(error)}`);
      return [];
    }
  });
  const results = await Promise.all(providerRuns);
  return uniqueUrls(results.flat());
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeFoldedText(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeDomain(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function titleFromSlug(slug) {
  return String(slug || "")
    .replace(/\.(html?|php)$/i, "")
    .split(/[-_]+/)
    .filter((part) => part && !/^(pt|pt-pt|portugal|braganca|lisboa|porto|coimbra|faro|setubal|aveiro|viseu)$/i.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
    .trim();
}

function normalizePlatformName(name, url) {
  const current = String(name || "").trim();
  if (!/^(agendoor|booksy|fresha|noona)\b/i.test(current)) return current;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || "";
    const candidate = titleFromSlug(slug);
    if (/\b(barbearia|barbeiro|barber|barbershop|grooming|talho|padaria)\b/i.test(candidate)) {
      return candidate;
    }
  } catch {
    return current;
  }
  return current;
}

function rowMergeKey(row) {
  const name = normalizeText(row.Nome);
  const website = normalizeDomain(row["Pagina web"]);
  const socials = normalizeDomain(row["Redes sociais"]);
  const phone = normalizePhone(row.Telefone);
  const email = normalizeText(row.Email);
  const locality = normalizeText(row.Localidade);
  const district = normalizeText(row.Distrito);
  if (email) return `email:${email}`;
  if (phone) return `phone:${phone}`;
  if (website) return `web:${website}|${name}`;
  if (socials) return `social:${socials}|${name}`;
  return [name, locality, district].filter(Boolean).join("|");
}

function extractJsonLdObjects(html) {
  const found = [];
  for (const match of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) found.push(...parsed);
      else found.push(parsed);
    } catch {
      continue;
    }
  }
  return found;
}

function extractFromHtml(html, url, request) {
  const jsonLdObjects = extractJsonLdObjects(html);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const metaDescription =
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1] ||
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)?.[1] ||
    "";
  const canonical =
    html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)?.[1] ||
    html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)?.[1] ||
    "";
  const socialLinks = [];
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = htmlDecode(match[1]);
    if (/facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com/i.test(href)) {
      socialLinks.push(href);
    }
  }
  const emails = new Set();
  for (const match of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    emails.add(match[0]);
  }
  for (const match of html.matchAll(/mailto:([^"'>\s]+)/gi)) {
    emails.add(decodeMaybeUrl(match[1]).replace(/^mailto:/i, ""));
  }
  const phones = new Set();
  for (const match of html.matchAll(/tel:([^"'>\s]+)/gi)) {
    phones.add(decodeMaybeUrl(match[1]).replace(/^tel:/i, ""));
  }
  for (const match of html.matchAll(/(?:\+?351[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?){3,4}\d{2,4}/g)) {
    const cleaned = match[0].trim();
    if (cleaned.replace(/\D/g, "").length >= 7) phones.add(cleaned);
  }

  const nameFromLd = jsonLdObjects.find((item) => item && typeof item === "object" && (item["@type"] === "LocalBusiness" || item["@type"] === "Organization"));
  const jsonLd = nameFromLd || {};
  const rawText = stripTags(html);
  const name = String(jsonLd.name || html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1] || title || "")
    .replace(/\s+/g, " ")
    .trim();

  let website = String(jsonLd.url || canonical || url).trim();
  if (website) {
    try {
      const parsed = new URL(website);
      if (/google\.(?:com|pt)/i.test(parsed.hostname) && /maps/i.test(parsed.pathname)) {
        website = "";
      }
    } catch {
      website = "";
    }
  }

  const locality = String(
    (jsonLd.address && typeof jsonLd.address === "object" && (jsonLd.address.addressLocality || jsonLd.address.addressRegion)) ||
      request.geography ||
      "",
  ).trim();
  const district = String(
    (jsonLd.address && typeof jsonLd.address === "object" && jsonLd.address.addressRegion) ||
      (request.geography && /portugal/i.test(String(request.geography)) ? "" : request.geography) ||
      "",
  ).trim();

  const social = [...new Set(socialLinks)].join(" | ");
  const email = [...emails][0] || "";
  const phone = [...phones][0] || String(jsonLd.telephone || "").trim();

  const sourceList = [url];
  if (canonical && canonical !== url) sourceList.push(canonical);
  if (metaDescription) sourceList.push(metaDescription.slice(0, 120));

  const row = {
    Nome: normalizePlatformName(name, website || url),
    "Pagina web": website,
    "Redes sociais": social,
    Email: email,
    Telefone: phone,
    Localidade: locality,
    Distrito: district,
    "Fontes consultadas": [...new Set(sourceList.filter(Boolean))].join(" | "),
    Observacoes: [
      sourceTypeNote(),
      metaDescription ? "Meta descrição confirmada." : "",
      social ? "Rede social pública encontrada." : "",
    ]
      .filter(Boolean)
      .join(" | "),
  };

  if (!row.Nome) {
    const titleFallback = rawText.slice(0, 100);
    row.Nome = titleFallback;
  }

  return row;
}

function extractOnDecortarRows(html, url, request) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return [];
  }
  if (!parsedUrl.hostname.includes("ondecortar.pt") || !parsedUrl.pathname.includes("/cidades/")) {
    return [];
  }

  const rows = [];
  const locality =
    String(request.geography || "").trim() ||
    parsedUrl.pathname
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/-/g, " ") ||
    "";

  for (const match of html.matchAll(/<article\s+class="card"[\s\S]*?<\/article>/gi)) {
    const block = match[0];
    const titleMatch = block.match(/<h3>\s*<a\s+href="([^"]+)">([\s\S]*?)<\/a>\s*<\/h3>/i);
    if (!titleMatch) continue;
    const profileUrl = new URL(htmlDecode(titleMatch[1]), url).toString();
    const name = stripTags(titleMatch[2]);
    const phoneMatch = block.match(/href="tel:([^"]+)"/i);
    const addressMatch = block.match(/<strong>\s*Morada:\s*<\/strong>\s*([^<]+)/i);
    const phone = phoneMatch ? htmlDecode(phoneMatch[1]).trim() : "";
    const address = addressMatch ? htmlDecode(addressMatch[1]).trim() : "";
    if (!name || !phone) continue;

    rows.push({
      Nome: name,
      "Pagina web": profileUrl,
      "Redes sociais": "",
      Email: "",
      Telefone: phone,
      Localidade: locality,
      Distrito: locality,
      "Fontes consultadas": url,
      Observacoes: [sourceTypeNote(), "Barbearia extraida de listagem OndeCortar.", address ? `Morada: ${address}` : ""]
        .filter(Boolean)
        .join(" | "),
    });
  }
  return rows;
}

function sourceTypeNote() {
  switch (SOURCE_TYPE) {
    case "maps":
      return "Fonte Maps";
    case "social":
      return "Fonte redes sociais";
    case "directories":
      return "Fonte diretórios";
    case "free":
      return "Fonte livre";
    default:
      return "Fonte web";
  }
}

function leadMatchesRequestedType(row, leadType) {
  const requested = normalizeText(leadType);
  const haystack = normalizeText(
    [row.Nome, row["Pagina web"], row["Redes sociais"], row.Observacoes, row["Fontes consultadas"]].join(" "),
  );
  if (!requested || requested === "leads") return true;
  if (/barbear|barber/.test(requested)) {
    const positive = /\b(barbearia|barbeiro|barber|barbershop|barber shop|grooming)\b/.test(haystack);
    const wrongOnly = /\b(cabeleireir|cabeleireiro|cabeleireira|estetica|estética)\b/.test(haystack);
    return positive && !wrongOnly;
  }
  if (/talh|carn/.test(requested)) {
    return /\b(talho|talhos|butcher|butcher shop|carne|carnes)\b/.test(haystack);
  }
  return true;
}

function writeCsvHeader(columns) {
  if (!fs.existsSync(OUTPUT_FILE) || fs.statSync(OUTPUT_FILE).size === 0) {
    fs.writeFileSync(OUTPUT_FILE, `${columns.map(escapeCsvCell).join(";")}\r\n`, "utf8");
  }
}

function appendRow(columns, row) {
  const line = columns.map((column) => escapeCsvCell(row[column] || "")).join(";");
  fs.appendFileSync(OUTPUT_FILE, `${line}\r\n`, "utf8");
}

function updateResponse(patch) {
  const current = readJson(RESPONSE_FILE, {});
  writeJson(RESPONSE_FILE, {
    ...current,
    ...patch,
    csvPath: OUTPUT_FILE.replace(/\\/g, "/"),
    updatedAt: new Date().toISOString(),
  });
}

async function runPythonPaiScraper(request, columns) {
  const pythonExe = process.env.PYTHON_EXE || "python";
  const outputArgs = [
    PYTHON_ENTRY,
    "--query",
    String(request.leadType || "talho"),
    "--location",
    String(request.geography || "Portugal"),
    "--output",
    OUTPUT_FILE,
    "--response-file",
    RESPONSE_FILE,
    "--max-pages",
    "5",
  ];
  const child = spawnSync(pythonExe, outputArgs, {
    cwd: APP_DIR,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      LEAD_WORKER_SOURCE_TYPE: SOURCE_TYPE,
      LEAD_WORKER_SOURCE_LABEL: SOURCE_LABEL,
      LEAD_WORKER_REQUEST_FILE: REQUEST_FILE,
      LEAD_WORKER_RESPONSE_FILE: RESPONSE_FILE,
      LEAD_WORKER_LOG_FILE: LOG_FILE,
    },
  });
  if (child.stdout) {
    fs.appendFileSync(LOG_FILE, child.stdout, "utf8");
    process.stdout.write(child.stdout);
  }
  if (child.stderr) {
    fs.appendFileSync(LOG_FILE, child.stderr, "utf8");
    process.stderr.write(child.stderr);
  }
  if (child.status !== 0) {
    throw new Error(`Pai scraper exited with code ${child.status}`);
  }
  const response = readJson(RESPONSE_FILE, {});
  updateResponse({
    ...response,
    status: "completed",
    writtenRows: response.writtenRows || 0,
    foundRows: response.foundRows || 0,
    blockers: response.blockers || [],
    notes: response.notes || [],
  });
}

async function runGenericScraper(request, columns) {
  const queries = buildQueries(request);
  const seenUrls = new Set();
  const seenRows = new Set();
  let writtenRows = 0;
  let foundRows = 0;
  const blockers = [];
  const notes = [];
  const maxResultsPerQuery = 18;

  writeCsvHeader(columns);
  updateResponse({
    status: "running",
    profile: SOURCE_TYPE,
    writtenRows,
    foundRows,
    blockers,
    notes,
  });

  const seededUrls = directSeedUrls(request);
  if (seededUrls.length) {
    log(`${SOURCE_LABEL}: ${seededUrls.length} URLs diretas adicionadas`);
  }

  for (const query of ["__direct_seeds__", ...queries]) {
    const urls = query === "__direct_seeds__" ? seededUrls : await searchQuery(query);
    if (!urls.length) {
      if (query !== "__direct_seeds__") blockers.push(`Sem resultados para "${query}"`);
      updateResponse({ blockers, writtenRows, foundRows, notes });
      continue;
    }

    const shortlisted = urls.slice(0, maxResultsPerQuery);
    for (const candidateUrl of shortlisted) {
      if (seenUrls.has(candidateUrl)) continue;
      seenUrls.add(candidateUrl);
      foundRows += 1;
      try {
        const html = await fetchHtml(candidateUrl, 2);
        const extractedRows = extractOnDecortarRows(html, candidateUrl, request);
        if (!extractedRows.length) extractedRows.push(extractFromHtml(html, candidateUrl, request));
        for (const row of extractedRows) {
          if (!row.Nome) continue;
          if (!leadMatchesRequestedType(row, request.leadType)) {
            notes.push(`Ignorado por categoria: ${row.Nome}`);
            continue;
          }
          const key = rowMergeKey(row);
          if (!key || seenRows.has(key)) continue;
          seenRows.add(key);
          appendRow(columns, row);
          writtenRows += 1;
          if (writtenRows % 2 === 0) {
            log(`${SOURCE_LABEL}: ${writtenRows} potenciais leads guardadas`);
          }
        }
        updateResponse({
          status: "running",
          profile: SOURCE_TYPE,
          writtenRows,
          foundRows,
          blockers,
          notes,
        });
      } catch (error) {
        blockers.push(`${candidateUrl} -> ${error.message}`);
      }
    }
  }

  updateResponse({
    status: "completed",
    profile: SOURCE_TYPE,
    writtenRows,
    foundRows,
    blockers,
    notes,
  });
}

async function main() {
  const request = readJson(REQUEST_FILE, {});
  const columns = String(request.columns || DEFAULT_COLUMNS)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const responseSeed = {
    status: "starting",
    profile: SOURCE_TYPE,
    writtenRows: 0,
    foundRows: 0,
    blockers: [],
    notes: [],
    csvPath: OUTPUT_FILE.replace(/\\/g, "/"),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(RESPONSE_FILE), { recursive: true });
  writeJson(RESPONSE_FILE, responseSeed);
  writeCsvHeader(columns);

  log(`${SOURCE_LABEL}: a iniciar worker de fonte`);
  try {
    if (SOURCE_TYPE === "directories") {
      await runPythonPaiScraper(request, columns);
    } else {
      await runGenericScraper(request, columns);
    }
    log(`${SOURCE_LABEL}: concluído`);
    updateResponse({
      status: "completed",
      profile: SOURCE_TYPE,
      writtenRows: readJson(RESPONSE_FILE, {}).writtenRows || 0,
      foundRows: readJson(RESPONSE_FILE, {}).foundRows || 0,
      blockers: readJson(RESPONSE_FILE, {}).blockers || [],
      notes: readJson(RESPONSE_FILE, {}).notes || [],
    });
  } catch (error) {
    log(`${SOURCE_LABEL}: falhou -> ${error.message}`);
    updateResponse({
      status: "failed",
      error: error.message,
    });
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    log(`Erro fatal: ${error.stack || error.message}`);
    updateResponse({ status: "failed", error: error.message });
    process.exit(1);
  });
