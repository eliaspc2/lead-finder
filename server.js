const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, "public");
const RUNS_DIR = path.join(APP_DIR, "runs");
const TOOLS_DIR = path.join(APP_DIR, "tools");
const PORT = Number(process.env.PORT || 41773);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_OUTPUT_NAME = "leads.csv";
const DEFAULT_COLUMNS = "Nome;Pagina web;Redes sociais;Email;Telefone;Localidade;Distrito;Fontes consultadas;Observacoes";
const AGGREGATE_POLL_MS = Number(process.env.AGGREGATE_POLL_MS || 60000);
const DEFAULT_WORKER_COMMAND = process.env.WORKER_COMMAND || process.execPath;
const DEFAULT_FINAL_REVIEW_COMMAND =
  process.env.CODEX_COMMAND ||
  process.env.CODEX_EXE ||
  (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "codex.exe") : "");
const DEFAULT_FINAL_REVIEW_MODEL = process.env.LEAD_REVIEW_MODEL || "gpt-5.4-mini";
const SOURCE_PROFILES = [
  {
    key: "directories",
    label: "Diretórios locais",
    sourceType: "directories",
    focus: "diretórios locais, associações e listagens setoriais",
    priorityDomains: ["hotfrog.pt", "cylex.pt", "tuugo.pt", "misterwhat.pt", "infobel.com", "paginasamarelas.pt"],
  },
  {
    key: "web",
    label: "Pesquisa web",
    sourceType: "search",
    focus: "sites oficiais e páginas de contacto",
    priorityDomains: [".pt", ".com"],
  },
  {
    key: "maps",
    label: "Google Maps",
    sourceType: "maps",
    focus: "resultados de mapas e fichas locais",
    priorityDomains: ["google.com", "maps.google.com", "googleusercontent.com"],
  },
  {
    key: "social",
    label: "Redes sociais",
    sourceType: "social",
    focus: "Facebook, Instagram e outras redes públicas",
    priorityDomains: ["facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com"],
  },
  {
    key: "free",
    label: "Pesquisa livre",
    sourceType: "free",
    focus: "qualquer estratégia pública promissora",
    priorityDomains: [],
  },
];

const runs = new Map();

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nowStamp() {
  return new Date().toLocaleTimeString("pt-PT", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function computeAggregatePollMs() {
  return 1000;
}

function safeJsonParse(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return safeJsonParse(fs.readFileSync(filePath, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function splitArgs(text) {
  const input = String(text || "").trim();
  if (!input) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s"]+)/g;
  let match;
  while ((match = re.exec(input))) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

function substitute(text, vars) {
  return String(text || "").replace(/%([A-Z_]+)%/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `%${key}%`;
  });
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": headers.contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? safeJsonParse(raw, {}) : {};
}

async function ensureDirs() {
  await fsp.mkdir(RUNS_DIR, { recursive: true });
}

function pushEvent(run, message) {
  run.events = run.events || [];
  run.events.push({ at: nowStamp(), message });
  if (run.events.length > 30) run.events.shift();
}

function describeCodexLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  if (!text.startsWith("{")) return text;

  const payload = safeJsonParse(text, null);
  if (!payload || typeof payload !== "object") return text;

  switch (payload.type) {
    case "thread.started":
      return `Thread iniciada${payload.thread_id ? ` (${payload.thread_id})` : ""}`;
    case "turn.started":
      return "Codex a pensar";
    case "item.started":
      if (payload.item?.type === "web_search") return "A pesquisar na web";
      if (payload.item?.type === "shell_command") return "A preparar ficheiros locais";
      return `A trabalhar (${payload.item?.type || "tarefa"})`;
    case "item.completed":
      if (payload.item?.type === "agent_message") {
        const snippet = String(payload.item.text || "").trim().replace(/\s+/g, " ");
        return snippet ? snippet.slice(0, 180) : "Mensagem pronta";
      }
      if (payload.item?.type === "web_search") {
        const query = payload.item.action?.query || payload.item.query || "";
        return query ? `Pesquisa concluída: ${query}` : "Pesquisa concluída";
      }
      if (payload.item?.type === "function_call") {
        return `Ferramenta: ${payload.item.name || "desconhecida"}`;
      }
      return `Item concluído (${payload.item?.type || "desconhecido"})`;
    case "turn.completed":
      return "Codex terminou o turno";
    case "error":
      return payload.message || payload.error || text;
    default:
      return payload.message || text;
  }
}

function humanizeLogLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;

  if (text.includes("Failed to create shell snapshot")) {
    return "A preparar o ambiente de trabalho";
  }
  if (text.includes("prompt must be at most 128 characters")) {
    return "A carregar definições de plugin";
  }
  if (text.includes("icon path must not contain '..'")) {
    return "A validar recursos dos plugins";
  }
  if (text.includes("GITHUB_PAT_TOKEN for MCP server 'github' is not set")) {
    return "Ligação a integrações opcionalmente indisponível";
  }
  if (text.startsWith("Reading prompt from stdin")) {
    return "A receber o briefing";
  }
  if (text.startsWith("SUCCESS: The process")) {
    return "Processo anterior encerrado";
  }

  return text;
}

function buildWorkerBrief(task, runDir, profile) {
  const queryHints = {
    web: "websites oficiais e páginas de contacto",
    maps: "Google Maps e fichas locais",
    social: "Facebook, Instagram e outras redes públicas",
    directories: "Páginas Amarelas, Hotfrog, Cylex, Tuugo, MisterWhat e similares",
    free: "qualquer fonte pública que ajude a descobrir leads válidas",
  };
  return [
    `Fonte: ${profile.label}`,
    `Tipo de fonte: ${profile.sourceType}`,
    `Alvo: ${task.leadType} em ${task.geography}`,
    `Pasta de trabalho: ${runDir.replace(/\\/g, "/")}`,
    `Pistas preferidas: ${queryHints[profile.sourceType] || "fontes públicas relevantes"}`,
    `Domínios prioritários: ${(profile.priorityDomains || []).join(", ") || "nenhum"}`,
    "",
    "Objetivo da frente:",
    "- descobrir leads reais e escrever cada linha válida no CSV da fonte;",
    "- manter response.json atualizado com estado, contagens e bloqueios;",
    "- evitar duplicados óbvios dentro da própria frente;",
    "- deixar o master fazer a deduplicação final e a consolidação.",
  ].join("\n");
}

function buildPrompt(data, runDir, profile) {
  const geography = String(data.geography || "Portugal").trim();
  const leadType = String(data.leadType || "leads").trim();
  const columns = String(data.columns || DEFAULT_COLUMNS).trim();
  const outputName = String(data.outputName || DEFAULT_OUTPUT_NAME).trim();
  const strictGeography = geography.toLowerCase() !== "portugal";
  const geographyLabel = strictGeography ? geography : "todo o país";

  return [
    "Tu és o Codex. Esta instância trabalha de forma autonoma num projeto local em que tens de procurar leads da seguinte forma:",
    "",
    `Foco desta instância: ${profile.label}.`,
    "Objetivo desta instância:",
    `Encontrar o máximo possível de leads de ${leadType} em ${geography}.`,
    `Geografia obrigatória: ${geographyLabel}.`,
    "",
    "Regras:",
    "- Procura apenas empresas que correspondam claramente ao tipo pedido.",
    "- Não mistures outras categorias no resultado, mesmo que pareçam relacionadas.",
    "- Se o nome ou a descrição da empresa não indicar claramente o tipo pedido, descarta-a.",
    "- Para barbearias, aceita variações como barbearia, barber shop ou barbershop, mas não outros negócios.",
    strictGeography ? `- Aceita apenas empresas que estejam claramente em ${geography}. Não substituas por outras cidades ou distritos.` : null,
    strictGeography ? "- Se uma fonte mostrar outra localidade, rejeita a lead mesmo que o nome pareça bom." : null,
    "- Cada linha do CSV deve representar uma única lead.",
    "- Evita duplicados por nome e, quando possível, por website/domínio.",
    "- Usa apenas contactos públicos verificáveis.",
    "- Só inclui a lead se conseguires pelo menos um contacto público útil: email ou telefone.",
    "- Se um campo não existir, deixa-o vazio.",
    "- Se houver vários contactos do mesmo tipo, junta-os com ' | '.",
    "- Prioriza fontes oficiais, websites das empresas, Google Maps, redes sociais e diretórios locais.",
    "- A coluna 'Pagina web' deve ter apenas website oficial ou página própria da empresa.",
    "- URLs de pesquisa, categorias, listagens de diretórios ou páginas agregadoras ficam só em 'Fontes consultadas'.",
    "- Não inventes dados.",
    "- Esta frente tem de ser rápida e pragmática: primeiro encontra e escreve, depois refina o que for preciso.",
    "- Não percorres a internet de forma exaustiva à procura de perfeição.",
    "- A estratégia correta é: pesquisa curta -> primeira lead válida -> grava no CSV -> continua.",
    "- Não guardes as leads apenas no fim.",
    "- Sempre que encontrares uma lead válida, escreve-a imediatamente no CSV.",
    "- Depois de cada 1 a 2 leads novas, guarda o ficheiro antes de continuar a pesquisar.",
    "- Se só encontrares uma lead válida, escreve essa lead logo; não esperes por encontrar mais.",
    "- Se uma via não estiver a produzir contactos úteis depois de poucas tentativas, muda de fonte.",
    "- Não repitas as mesmas pesquisas só para confirmar mais uma vez.",
    "- Prefere terminar com menos leads boas a demorar demasiado com validação repetida.",
    "",
    `Nesta execução, concentra-te em: ${profile.focus}.`,
    profile.instructions,
    "",
    "Plano de execução curto:",
    "- Começa por 3 a 5 pesquisas muito focadas e extrai logo as primeiras leads válidas.",
    "- Se uma pesquisa devolver uma ficha útil, escreve a linha sem esperar por uma segunda fonte perfeita.",
    "- Se a fonte principal falhar, troca imediatamente para outra via do teu foco.",
    "- Mantém o ritmo: encontrar -> escrever -> continuar.",
    strictGeography ? `- Na pesquisa, começa por consultas com ${geography} e não saltes para outras cidades.` : null,
    "",
    "CSV:",
    `- Usa o ficheiro CSV chamado ${outputName} dentro desta pasta de trabalho: ${runDir.replace(/\\/g, "/")}.`,
    "- Escreve também um ficheiro response.json na mesma pasta para responder ao master.",
    "- O ficheiro já pode existir com cabeçalho; preserva o cabeçalho e acrescenta linhas válidas.",
    `- Usa o separador ';' e codificação UTF-8.`,
    `- Usa exatamente estas colunas, por esta ordem: ${columns}.`,
    "- Mantém sempre o CSV num estado válido enquanto trabalhas, para outro processo conseguir lê-lo a qualquer momento.",
    "- Não devolvas markdown na saída final; devolve o ficheiro e, no máximo, um resumo curto no terminal.",
    "",
    "Regras por campo:",
    "- Nome: nome comercial da empresa.",
    "- Pagina web: website oficial ou página própria da empresa; não uses páginas de listagem ou pesquisa.",
    "- Redes sociais: link direto para Instagram, Facebook ou outra rede social pública relevante, se existir.",
    "- Email: email público da empresa, se existir.",
    "- Telefone: telefone público da empresa, se existir.",
    "- Localidade: localidade principal.",
    "- Distrito: distrito ou região administrativa.",
    "- Fontes consultadas: URLs ou fontes usadas para validar a lead.",
    "- Observacoes: notas curtas sobre validação, filiais, ou ausência de campos.",
    "",
    "Entrega:",
    "- Devolve apenas o ficheiro CSV e, no máximo, um resumo curto no terminal.",
    "- Não devolvas uma análise longa da pesquisa; o importante é o ficheiro com leads úteis.",
    "- Antes de terminares, atualiza response.json com status, profile, writtenRows, foundRows, blockers, notes e csvPath.",
    "- O master usa response.json para perceber o que fizeste sem ler o log inteiro.",
    "",
    "Podes consultar Google Maps e resultados de mapas quando ajudem a validar moradas, contactos ou presença local.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseCommand(commandText, fallbackCommand) {
  const text = String(commandText || "").trim();
  if (!text) return { command: fallbackCommand, args: [] };
  const [command, ...rest] = splitArgs(text);
  if (!command) return { command: fallbackCommand, args: [] };
  return { command, args: rest };
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ";" && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  return cells;
}

function parseCsvText(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((item) => item.trim());
  const rows = lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((key, index) => {
      row[key] = (values[index] ?? "").trim();
    });
    return row;
  });
  return { headers, rows };
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[;\n\r"]/u.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
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
    return text
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(/[/?#]/)[0];
  }
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isPlausiblePortuguesePhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return false;
  if (digits.startsWith("351")) return digits.length === 12 && /^[23569]/.test(digits.slice(3));
  return digits.length === 9 && /^[23569]/.test(digits);
}

function isPlausibleBrazilianPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return false;
  if (digits.startsWith("55")) return digits.length >= 12 && digits.length <= 13;
  return digits.length >= 10 && digits.length <= 11;
}

function requestedCountry(geography) {
  const requested = normalizeFoldedText(geography);
  if (/\bbrasil\b|\bbrazil\b|\bsp\b|\bsao paulo\b|\bbraganca paulista\b/.test(requested)) return "BR";
  return "PT";
}

function isPlausiblePhoneForGeography(value, geography) {
  const digits = normalizePhone(value);
  if (!digits) return false;
  return digits.length >= 9 && digits.length <= 15;
}

function isPublicBusinessEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  return !/(?:sentry\.io|booksy\.com|fresha\.com|example\.com)$/i.test(email);
}

function getRowValue(row, aliases) {
  for (const key of aliases) {
    const value = row[key];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function isGenericListingUrl(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\./, "");
    const pathname = url.pathname.toLowerCase();
    if (host.includes("barberhead.com")) return true;
    if (host.includes("google.") && pathname.includes("/maps")) return true;
    if (host.includes("maps.google.")) return true;
    if (host.includes("maps.app.goo.gl")) return true;
    if (host.includes("hotfrog.") && pathname.includes("/search/")) return true;
    if (host.includes("fresha.")) return true;
    if (host.includes("booksy.")) return true;
    if (host.includes("noona.")) return true;
    if (host.includes("agendoor.")) return true;
    if (host.includes("ondecortar.pt") && pathname.includes("/cidades/")) return true;
    if (host.includes("cylex.") && /\/barbearia\/?$|\/cabeleireiro\/?$|\/talho\/?$/.test(pathname)) return true;
    if (host.includes("pai.pt") && pathname.includes("/pesquisa/")) return true;
    if (host.includes("empresite.") && pathname.includes("/actividade/")) return true;
    if (host.includes("racius.") && pathname.includes("/pesquisa/")) return true;
    return false;
  } catch {
    return /\/search\/|\/lp\/|\/pesquisa\/|google\.com\/maps|barberhead\.com/i.test(text);
  }
}

function sanitizeSocialLinks(value) {
  const blocked = [
    "getbarberhead",
    "barberheadcom",
    "frizurd",
    "paginasamarelas",
    "pai.pt",
    "fresha",
    "booksy",
    "shedul",
    "heyfresha",
  ];
  const allowed = ["facebook.com", "instagram.com", "tiktok.com", "linkedin.com", "youtube.com", "x.com", "twitter.com"];
  const parts = String(value || "")
    .split(" | ")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => allowed.some((domain) => part.toLowerCase().includes(domain)))
    .filter((part) => !blocked.some((marker) => part.toLowerCase().includes(marker)));
  return [...new Set(parts)].join(" | ");
}

function leadMatchesRequestedType(row, leadType) {
  const requested = normalizeText(leadType);
  const haystack = normalizeText(
    [row.Nome, row["Pagina web"], row["Redes sociais"], row.Observacoes].join(" "),
  );

  if (!requested || requested === "leads") return true;
  if (/barbear|barber/.test(requested)) {
    const positive = /\b(barbearia|barbeiro|barber|barbershop|barber shop|grooming)\b/.test(haystack);
    const wrongOnly = /\b(cabeleireir|cabeleireiro|cabeleireira|cabeleireiros|cabeleireiras|estetica|estética)\b/.test(haystack);
    return positive && !wrongOnly;
  }
  return true;
}

function leadMatchesRequestedGeography(row, geography) {
  const requested = normalizeFoldedText(geography);
  if (!requested || requested === "portugal") return true;

  const rawHaystack = normalizeFoldedText(
    [
      row.Localidade,
      row.Distrito,
      row.Nome,
      row["Pagina web"],
      row["Redes sociais"],
      row.Observacoes,
    ].join(" "),
  );
  const haystack = normalizeFoldedText(
    [
      row.Localidade,
      row.Distrito,
      row.Nome,
      row["Pagina web"],
      row["Redes sociais"],
    ].join(" "),
  );

  const aliases = new Set([requested]);
  if (requested.includes("braganca")) aliases.add("bragança");
  if (requested.includes("acores")) aliases.add("açores");
  return [...aliases].some((alias) => haystack.includes(alias));
}

function looksLikeSearchPortal(row) {
  const haystack = normalizeFoldedText(
    [row.Nome, row["Pagina web"], row["Redes sociais"], row.Email, row.Observacoes, row["Fontes consultadas"]].join(" "),
  );
  return /\byahoo\b|\bshopping yahoo\b|\byahoo mail\b|\byahoo sports\b|\byahoo news\b|\bexample@email\.com\b/.test(haystack);
}

function isGenericLeadWebsite(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\./, "");
    const pathname = url.pathname.toLowerCase();
    if (host.includes("pai.pt") && pathname.includes("/search")) return true;
    if (host.includes("google.") && pathname.includes("/maps")) return true;
    if (host.includes("maps.google.")) return true;
    if (host.includes("maps.app.goo.gl")) return true;
    if (host.includes("booksy.com") && pathname.includes("/search")) return true;
    if (host.includes("fresha.")) return true;
    if (host.includes("booksy.")) return true;
    if (host.includes("noona.")) return true;
    if (host.includes("agendoor.")) return true;
    if (host.includes("ondecortar.pt") && pathname.includes("/cidades/")) return true;
    if (host.includes("cylex.") && pathname.includes("/search")) return true;
    if (host.includes("hotfrog.") && pathname.includes("/search")) return true;
    if (host.includes("infobel.") && pathname.includes("/search")) return true;
    if (host.includes("tuugo.") && pathname.includes("/search")) return true;
    return false;
  } catch {
    return /\/search\/|\/maps|maps\.app\.goo\.gl/i.test(text);
  }
}

function buildLeadReviewPrompt(row, leadType, geography, context = {}) {
  return [
    "You are validating a business lead before it is added to a final CSV.",
    "Use judgement: infer geography from the requested text and from the lead fields. Do not rely on hardcoded country assumptions.",
    "Return ONLY compact JSON with this shape:",
    '{"approved":true|false,"reason":"short reason","issues":["..."],"normalized":{"Nome":"","Pagina web":"","Redes sociais":"","Email":"","Telefone":"","Localidade":"","Distrito":"","Fontes consultadas":"","Observacoes":""}}',
    "",
    `Requested business type: ${leadType}`,
    `Requested geography: ${geography}`,
    `Source context: ${context.sourceLabel || context.sourceType || "unknown"}`,
    "",
    "Rules:",
    "- Approve only if the lead clearly matches the requested type.",
    "- Decide the intended geography from the user's requested geography and the evidence in the row. If the user writes only a city name, infer the likely country from sources, addresses, domains, phone prefixes, and language.",
    "- Reject if the geography is clearly wrong or unrelated, but approve when the district/region matches the requested place even if the locality is nearby.",
    "- Reject if there is no public phone or email.",
    "- A directory/profile page is acceptable as a source when the row itself represents a real business, not the directory.",
    "- Fresha, Booksy, Noona, Infobel, OndeCortar, FindGlocal, and similar profile pages can be valid sources when they identify a real business with a public phone or email.",
    "- Reject if the row itself is a search engine, portal, category page, platform homepage, or unrelated service.",
    "- If a website field is blank because the only source is a directory/profile, approve anyway when the business and contact are clear.",
    "- If approved, you may lightly normalize fields but do not invent data.",
    "",
    "Lead JSON:",
    JSON.stringify(row, null, 2),
  ].join("\n");
}

function extractLeadReviewText(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      const item = payload?.item;
      if (item && (item.type === "agent_message" || item.type === "assistant_message")) {
        const text = String(item.text || "").trim();
        if (text) candidates.push(text);
      }
    } catch {
      if (/^\s*\{[\s\S]*\}\s*$/.test(line)) candidates.push(line);
    }
  }
  if (candidates.length) return candidates[candidates.length - 1];
  return lines[lines.length - 1] || "";
}

function parseLeadReviewPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function runLeadReviewAi(row, leadType, geography, context = {}) {
  if (!DEFAULT_FINAL_REVIEW_COMMAND || !fs.existsSync(DEFAULT_FINAL_REVIEW_COMMAND)) {
    return { approved: true, reason: "Validador AI indisponível; validação local aplicada." };
  }
  const prompt = buildLeadReviewPrompt(row, leadType, geography, context);
  const result = spawnSync(
    DEFAULT_FINAL_REVIEW_COMMAND,
    ["exec", "--skip-git-repo-check", "--json", "--model", DEFAULT_FINAL_REVIEW_MODEL],
    {
      input: prompt,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 25000,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
      },
    },
  );
  const stdout = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const reviewText = extractLeadReviewText(stdout);
  const payload = parseLeadReviewPayload(reviewText);
  if (!payload || typeof payload !== "object") {
    return {
      approved: true,
      reason: "Validador AI inconclusivo; validação local aplicada.",
      aiOutput: reviewText.slice(0, 500),
    };
  }
  return {
    approved: Boolean(payload.approved),
    reason: String(payload.reason || "").trim() || (payload.approved ? "Aprovada pela IA." : "Rejeitada pela IA."),
    issues: Array.isArray(payload.issues) ? payload.issues : [],
    normalized: payload.normalized && typeof payload.normalized === "object" ? payload.normalized : null,
    aiOutput: reviewText.slice(0, 500),
  };
}

function validateLeadCandidate(row, leadType, geography, context = {}) {
  const localRow = { ...row };
  const name = String(localRow.Nome || "").trim();
  let email = String(localRow.Email || "").trim();
  let phone = String(localRow.Telefone || "").trim();
  const foldedName = normalizeFoldedText(name);
  let phoneDigits = normalizePhone(phone);
  const platformEmail = email && !isPublicBusinessEmail(email);

  if (phone && !isPlausiblePhoneForGeography(phone, geography)) {
    localRow.Telefone = "";
    phone = "";
    phoneDigits = "";
  }
  if (platformEmail) {
    localRow.Email = "";
    email = "";
  }

  if (!name) {
    return { approved: false, reason: "Sem nome." };
  }
  if (!isPublicBusinessEmail(email) && !isPlausiblePhoneForGeography(phone, geography)) {
    return { approved: false, reason: "Sem contacto público." };
  }
  if (/^barbearias?\s+em\b/.test(foldedName) || foldedName.includes("onde cortar")) {
    return { approved: false, reason: "Página de categoria/listagem, não é uma lead." };
  }
  if (looksLikeSearchPortal(localRow)) {
    return { approved: false, reason: "Resultado de portal/motor de busca, não é uma lead." };
  }

  const ai = runLeadReviewAi(localRow, leadType, geography, context);
  if (!ai.approved) {
    return { approved: false, reason: ai.reason || "Rejeitada pela validação.", aiOutput: ai.aiOutput, issues: ai.issues || [] };
  }

  const merged = { ...localRow };
  if (ai.normalized && typeof ai.normalized === "object") {
    for (const [key, value] of Object.entries(ai.normalized)) {
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      if (text) merged[key] = text;
    }
  }
  return { approved: true, reason: ai.reason || "Aprovada pela IA.", row: merged, issues: ai.issues || [] };
}

function rowMergeKey(row) {
  const name = normalizeText(row.Nome);
  const website = isGenericListingUrl(row["Pagina web"]) ? "" : normalizeDomain(row["Pagina web"]);
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

function mergeRow(target, incoming) {
  for (const [key, value] of Object.entries(incoming)) {
    const clean = String(value || "").trim();
    if (!clean) continue;
    if (!target[key]) {
      target[key] = clean;
      continue;
    }
    if (target[key] === clean) continue;
    if (key === "Fontes consultadas" || key === "Observacoes") {
      const merged = new Set(
        String(target[key])
          .split(" | ")
          .map((part) => part.trim())
          .filter(Boolean),
      );
      for (const part of clean.split(" | ").map((part) => part.trim()).filter(Boolean)) merged.add(part);
      target[key] = [...merged].join(" | ");
    }
  }
}

function mergeCsvFiles(inputFiles, outputFile, columns, leadType, limit = null, geography = "", validationCache = new Map()) {
  const headers = String(columns || DEFAULT_COLUMNS)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = new Map();
  const stats = {
    kept: 0,
    duplicates: 0,
    skippedNoContact: 0,
    skippedNoName: 0,
    skippedWrongType: 0,
    clearedGenericWebsite: 0,
    rejectedByValidation: 0,
    validationErrors: 0,
  };

  for (const file of inputFiles) {
    if (!fs.existsSync(file)) continue;
    const { rows } = parseCsvText(fs.readFileSync(file, "utf8"));
    for (const row of rows) {
      const normalized = {};
      for (const header of headers) normalized[header] = String(row[header] || "").trim();
      normalized.Nome = getRowValue(row, ["Nome", "Name"]) || normalized.Nome;
      normalized["Pagina web"] = getRowValue(row, ["Pagina web", "Website", "Site", "Página web"]) || normalized["Pagina web"];
      normalized["Redes sociais"] =
        getRowValue(row, ["Redes sociais", "Facebook", "Instagram", "Social", "Redes"]) || normalized["Redes sociais"];
      normalized.Email = getRowValue(row, ["Email", "E-mail", "E mail"]) || normalized.Email;
      normalized.Telefone = getRowValue(row, ["Telefone", "Phone", "Telemóvel", "Telemovel"]) || normalized.Telefone;
      normalized.Localidade = getRowValue(row, ["Localidade", "Cidade", "City"]) || normalized.Localidade;
      normalized.Distrito = getRowValue(row, ["Distrito", "Região", "Regiao", "Region"]) || normalized.Distrito;
      normalized["Fontes consultadas"] =
        getRowValue(row, ["Fontes consultadas", "Fontes", "Sources"]) || normalized["Fontes consultadas"];
      normalized.Observacoes = getRowValue(row, ["Observacoes", "Observações", "Notas", "Notes"]) || normalized.Observacoes;
      normalized["Redes sociais"] = sanitizeSocialLinks(normalized["Redes sociais"]);

      if (isGenericListingUrl(normalized["Pagina web"])) {
        const source = normalized["Pagina web"];
        normalized["Pagina web"] = "";
        normalized["Fontes consultadas"] = [normalized["Fontes consultadas"], source].filter(Boolean).join(" | ");
        normalized.Observacoes = [normalized.Observacoes, "Pagina web removida por ser uma listagem generica."]
          .filter(Boolean)
          .join(" | ");
        stats.clearedGenericWebsite += 1;
      }

      if (!normalized.Email && !normalized.Telefone) {
        stats.skippedNoContact += 1;
        continue;
      }
      if (!normalized.Nome) {
        stats.skippedNoName += 1;
        continue;
      }
      if (!leadMatchesRequestedType(normalized, leadType)) {
        stats.skippedWrongType += 1;
        continue;
      }
      if (!leadMatchesRequestedGeography(normalized, geography)) {
        stats.skippedWrongType += 1;
        continue;
      }
      const cacheKey = `${rowMergeKey(normalized)}|${normalizeText(leadType)}|${normalizeFoldedText(geography)}`;
      let validation = validationCache.get(cacheKey);
      if (!validation) {
        validation = validateLeadCandidate(normalized, leadType, geography, { sourceFile: file });
        validationCache.set(cacheKey, validation);
      }
      if (!validation.approved) {
        stats.rejectedByValidation += 1;
        continue;
      }
      if (validation.row) {
        for (const header of headers) {
          if (Object.prototype.hasOwnProperty.call(validation.row, header)) {
            normalized[header] = String(validation.row[header] || "").trim();
          }
        }
        normalized.Observacoes = [normalized.Observacoes, validation.reason].filter(Boolean).join(" | ");
      }
      const key = rowMergeKey(normalized);
      if (!key) continue;
      if (!merged.has(key)) {
        merged.set(key, normalized);
      } else {
        stats.duplicates += 1;
        mergeRow(merged.get(key), normalized);
      }
    }
  }

  const validRows = [...merged.values()];
  const numericLimit = limit === null || limit === undefined ? null : Number(limit);
  const outputRows =
    numericLimit === null || !Number.isFinite(numericLimit) ? validRows : validRows.slice(0, Math.max(0, numericLimit));
  stats.totalValid = validRows.length;
  stats.kept = outputRows.length;
  const csv =
    `${headers.map(escapeCsvCell).join(";")}\r\n` +
    outputRows
      .map((row) => headers.map((header) => escapeCsvCell(row[header] || "")).join(";"))
      .join("\r\n") +
    (outputRows.length ? "\r\n" : "");
  fs.writeFileSync(outputFile, `\ufeff${csv}`, "utf8");
  return stats;
}

function collectProfileOutputFiles(run) {
  return SOURCE_PROFILES.map((profile) => path.join(run.dir, profile.key, "leads.csv")).filter((file) => fs.existsSync(file));
}

function outputFilesSignature(files) {
  return files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join("|");
}

function aggregateRunOutputs(run) {
  const outputFiles = collectProfileOutputFiles(run);
  if (!outputFiles.length) {
    run.aggregateStats = {
      kept: 0,
      totalValid: 0,
      duplicates: 0,
      skippedNoContact: 0,
      skippedNoName: 0,
      skippedWrongType: 0,
      clearedGenericWebsite: 0,
      rejectedByValidation: 0,
      validationErrors: 0,
    };
    return run.aggregateStats;
  }
  const signature = outputFilesSignature(outputFiles);
  if (run.lastAggregateSignature === signature && run.aggregateStats) {
    return run.aggregateStats;
  }
  run.lastAggregateSignature = signature;
  const stats = mergeCsvFiles(
    outputFiles,
    run.files.outputFile,
    run.request.columns || DEFAULT_COLUMNS,
    run.request.leadType,
    null,
    run.request.geography,
    run.validationCache || (run.validationCache = new Map()),
  );
  run.aggregateStats = stats;
  if (stats.kept > 0) run.result = run.files.outputFile;
  return stats;
}

function terminateProcessTree(pid) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    killer.on("error", () => resolve());
    killer.on("close", () => resolve());
  });
}

async function terminateRunChildren(run, reason) {
  if (run.terminationRequested) return;
  run.terminationRequested = true;
  run.terminationReason = reason;
  pushEvent(run, reason);
  const children = [...(run.children || [])];
  for (const child of children) {
    if (!child || child.killed || child.exitCode !== null) continue;
    await terminateProcessTree(child.pid);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchSourceRun(run, profile, request, dir) {
  const profileDir = path.join(dir, profile.key);
  await fsp.mkdir(profileDir, { recursive: true });
  const profileRequest = { ...request };
  const task = {
    ...profileRequest,
    profile: profile.key,
    sourceType: profile.sourceType,
    sourceLabel: profile.label,
    priorityDomains: profile.priorityDomains || [],
  };
  const promptFile = path.join(profileDir, "task.md");
  const requestFile = path.join(profileDir, "request.json");
  const logFile = path.join(profileDir, "worker.log");
  const outputFile = path.join(profileDir, "leads.csv");
  const responseFile = path.join(profileDir, "response.json");
  const workerEntry = path.join(TOOLS_DIR, "source-worker.js");
  const env = {
    ...process.env,
    CODEX_RUN_DIR: profileDir,
    LEAD_WORKER_RUN_DIR: profileDir,
    LEAD_WORKER_PROFILE: profile.key,
    LEAD_WORKER_SOURCE_TYPE: profile.sourceType,
    LEAD_WORKER_SOURCE_LABEL: profile.label,
    LEAD_WORKER_REQUEST_FILE: requestFile,
    LEAD_WORKER_PROMPT_FILE: promptFile,
    LEAD_WORKER_OUTPUT_FILE: outputFile,
    LEAD_WORKER_RESPONSE_FILE: responseFile,
    LEAD_WORKER_LOG_FILE: logFile,
    LEAD_WORKER_WORKER_ENTRY: workerEntry,
  };

  await Promise.all([
    fsp.writeFile(promptFile, buildWorkerBrief(task, profileDir, profile), "utf8"),
    fsp.writeFile(requestFile, JSON.stringify({ ...task, goal: "maximise leads found" }, null, 2), "utf8"),
    fsp.writeFile(logFile, "", "utf8"),
    fsp.writeFile(
      responseFile,
      JSON.stringify(
        {
          status: "starting",
          profile: profile.key,
          writtenRows: 0,
          foundRows: 0,
          blockers: [],
          notes: [],
          csvPath: outputFile.replace(/\\/g, "/"),
        },
        null,
        2,
      ),
      "utf8",
    ),
    fsp.writeFile(outputFile, `${(request.columns || DEFAULT_COLUMNS).trim()}\r\n`, "utf8"),
  ]);

  pushEvent(run, `A lançar a fonte ${profile.label}`);
  const child = spawn(DEFAULT_WORKER_COMMAND, [workerEntry], {
    cwd: profileDir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  run.children = run.children || new Set();
  run.children.add(child);
  run.pid = run.pid || child.pid;
  const profileRun = run.subruns?.find((item) => item.key === profile.key);
  if (profileRun) {
    profileRun.status = "running";
    profileRun.pid = child.pid || null;
  }
  pushEvent(run, `${profile.label} em execução${child.pid ? ` (PID ${child.pid})` : ""}`);

  const appendLog = (chunk) => {
    const text = chunk.toString("utf8");
    run.log += `\n[${profile.key}] ${text}`;
    fs.appendFileSync(logFile, text);
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2);
    for (const line of lines) {
      const message = humanizeLogLine(describeCodexLine(line) || line.slice(0, 160));
      pushEvent(run, `[${profile.label}] ${message}`);
    }
  };

  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  return new Promise((resolve) => {
    const finish = (payload) => resolve({ profile, promptFile, requestFile, logFile, outputFile, responseFile, ...payload });

    child.on("error", (err) => {
      run.children?.delete(child);
      if (profileRun) {
        profileRun.status = "failed";
        profileRun.error = err.message;
      }
      pushEvent(run, `[${profile.label}] Erro ao arrancar: ${err.message}`);
      fs.appendFileSync(logFile, `\n[launcher error] ${err.message}\n`);
      finish({ status: "failed", error: err.message, exitCode: null, outputExists: false });
    });

    child.on("close", (code) => {
      run.children?.delete(child);
      const outputExists = fs.existsSync(outputFile);
      if (profileRun) {
        profileRun.status = code === 0 && outputExists ? "completed" : outputExists ? "completed_with_warning" : "failed";
        profileRun.exitCode = code;
        profileRun.outputExists = outputExists;
        profileRun.response = readJsonIfExists(responseFile, null);
      }
      const response = readJsonIfExists(responseFile, null);
      if (response && typeof response === "object") {
        const writtenRows = Number(response.writtenRows || 0);
        const foundRows = Number(response.foundRows || 0);
        if (writtenRows || foundRows) {
          pushEvent(
            run,
            `[${profile.label}] Resposta ao master: ${writtenRows}/${foundRows} potenciais leads, estado ${response.status || "desconhecido"}`,
          );
        }
      }
      if (code === 0 && outputExists) {
        pushEvent(run, `[${profile.label}] Concluído com CSV gerado`);
      } else if (outputExists) {
        pushEvent(run, `[${profile.label}] Concluído com CSV, mas saída ${code}`);
      } else {
        pushEvent(run, `[${profile.label}] Sem CSV gerado`);
      }
      finish({
        status: code === 0 && outputExists ? "completed" : outputExists ? "completed_with_warning" : "failed",
        exitCode: code,
        outputExists,
      });
    });
  });
}

function startPipelineRun(run) {
  const { request, dir } = run;
  const outputFile = path.join(dir, request.outputName || DEFAULT_OUTPUT_NAME);
  const aggregatePollMs = computeAggregatePollMs();

  run.files = { outputFile };
  run.status = "starting";
  run.startedAt = new Date().toISOString();
  run.result = null;
  run.log = "";
  run.children = new Set();
  run.subruns = SOURCE_PROFILES.map((profile) => ({ key: profile.key, label: profile.label, status: "queued" }));
  pushEvent(run, "A preparar várias fontes de pesquisa para maximizar potenciais leads");

  return (async () => {
    await Promise.all([
      fsp.writeFile(path.join(dir, "request.json"), JSON.stringify(request, null, 2), "utf8"),
      fsp.writeFile(path.join(dir, "pipeline.log"), "", "utf8"),
    ]);

    run.status = "running";
    pushEvent(run, "A lançar fontes em paralelo");

    const runPromises = SOURCE_PROFILES.map((profile) =>
      launchSourceRun(run, profile, request, dir),
    );
    const settled = runPromises.map(() => false);
    for (const [index, promise] of runPromises.entries()) {
      promise.finally(() => {
        settled[index] = true;
      });
    }

    let lastProgress = -1;
    while (!settled.every(Boolean)) {
      const stats = aggregateRunOutputs(run);
      const validationState = `${stats.kept}:${stats.rejectedByValidation || 0}:${stats.validationErrors || 0}`;
      if (validationState !== lastProgress) {
        lastProgress = validationState;
        pushEvent(
          run,
          `Agregado actualizado: ${stats.kept} leads válidas, ${stats.rejectedByValidation || 0} resultados descartados por IA`,
        );
      }
      await sleep(aggregatePollMs);
    }

    const results = await Promise.allSettled(runPromises);
    const successfulOutputs = results
      .filter((result) => result.status === "fulfilled" && result.value.outputExists)
      .map((result) => result.value.outputFile);
    if (!successfulOutputs.length) {
      run.status = "failed";
      run.error = "Nenhuma frente gerou um CSV válido.";
      run.completedAt = new Date().toISOString();
      pushEvent(run, "Nenhuma frente gerou CSV válido");
      return;
    }

    const mergeStats = mergeCsvFiles(
      successfulOutputs,
      outputFile,
      request.columns || DEFAULT_COLUMNS,
      request.leadType,
      null,
      request.geography,
      run.validationCache || (run.validationCache = new Map()),
    );
    run.aggregateStats = mergeStats;
    run.result = outputFile;
    run.completedAt = new Date().toISOString();
    if (mergeStats.kept > 0) {
      run.status = "completed";
      pushEvent(
        run,
        `CSV final: ${mergeStats.kept} leads, ${mergeStats.duplicates} duplicados fundidos, ${mergeStats.skippedWrongType} fora da categoria removidos, ${mergeStats.rejectedByValidation || 0} descartados por IA`,
      );
      if (results.some((result) => result.status !== "fulfilled" || result.value.status !== "completed")) {
        run.warning = "Nem todas as fontes concluíram com sucesso, mas o CSV final foi gerado.";
        pushEvent(run, "CSV final gerado com algumas frentes incompletas");
      } else {
        pushEvent(run, "CSV final consolidado");
      }
    } else {
      run.status = "failed";
      run.error = "Os CSVs gerados não continham leads com contacto público válido.";
      pushEvent(run, "CSV final vazio após filtragem");
    }
  })();
}

function renderIndex() {
  return fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    send(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(safePath),
    "Cache-Control": "no-store",
  });
  fs.createReadStream(safePath).pipe(res);
}

function runSnapshot(runId, run) {
  return {
    id: runId,
    status: run.status,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    exitCode: run.exitCode ?? null,
    pid: run.pid ?? null,
    error: run.error || null,
    warning: run.warning || null,
    request: run.request,
    result: run.result || null,
    aggregateStats: run.aggregateStats || null,
    subruns: run.subruns || [],
    events: run.events || [],
    logTail: (run.log || "").split(/\r?\n/).slice(-60).join("\n"),
    files: run.files,
  };
}

async function handleApiRun(req, res) {
  const body = await readBody(req);
  const id = `run_${nowId()}`;
  const dir = path.join(RUNS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const run = {
    id,
    dir,
    request: {
      objective: String(body.objective || "").trim(),
      leadType: String(body.leadType || "").trim() || "leads",
      geography: String(body.geography || "").trim() || "Portugal",
      sources:
        "Pesquisa web, Google Maps, redes sociais, diretórios locais e pesquisa livre.",
      contactRule: String(body.contactRule || "").trim() || "pelo menos um contacto público",
      outputName: String(body.outputName || "").trim() || DEFAULT_OUTPUT_NAME,
      columns: DEFAULT_COLUMNS,
      extraInstructions: String(body.extraInstructions || "").trim(),
    },
    status: "queued",
    log: "",
    events: [],
  };
  runs.set(id, run);
  startPipelineRun(run).catch((err) => {
    run.status = "failed";
    run.error = err.message;
    run.completedAt = new Date().toISOString();
    pushEvent(run, `Falhou: ${err.message}`);
  });
  send(res, 200, JSON.stringify(runSnapshot(id, run)), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function handleApiStatus(req, res) {
  const runsArray = [...runs.entries()]
    .slice(-10)
    .reverse()
    .map(([id, run]) => runSnapshot(id, run));
  send(
    res,
    200,
    JSON.stringify({
      ok: true,
      pipelineCommand: DEFAULT_WORKER_COMMAND,
      pipelineReady: true,
      sources: SOURCE_PROFILES.map((profile) => ({
        key: profile.key,
        label: profile.label,
        sourceType: profile.sourceType,
      })),
      port: PORT,
      runs: runsArray,
    }),
    { "Content-Type": "application/json; charset=utf-8" },
  );
}

async function handleRunRead(req, res, runId) {
  const run = runs.get(runId);
  if (!run) {
    send(res, 404, JSON.stringify({ error: "Run not found" }), {
      "Content-Type": "application/json; charset=utf-8",
    });
    return;
  }
  send(res, 200, JSON.stringify(runSnapshot(runId, run)), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function handleFile(req, res, runId, filename) {
  const run = runs.get(runId);
  if (!run) {
    send(res, 404, "Run not found");
    return;
  }
  const filePath = path.join(run.dir, filename);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(run.dir) || !fs.existsSync(normalized)) {
    send(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(normalized),
    "Content-Disposition": `attachment; filename="${path.basename(normalized)}"`,
  });
  fs.createReadStream(normalized).pipe(res);
}

async function main() {
  await ensureDirs();
  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsed.pathname;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderIndex());
      return;
    }

    if (req.method === "GET" && (pathname === "/app.js" || pathname === "/styles.css")) {
      serveStatic(req, res, pathname.slice(1));
      return;
    }

    if (req.method === "GET" && pathname === "/api/status") {
      await handleApiStatus(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      await handleApiRun(req, res);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/runs/")) {
      const parts = pathname.split("/").filter(Boolean);
      const runId = parts[2];
      if (parts.length === 3) {
        await handleRunRead(req, res, runId);
        return;
      }
      if (parts.length === 5 && parts[3] === "files") {
        await handleFile(req, res, runId, parts[4]);
        return;
      }
    }

    send(res, 404, "Not found");
  });

  server.listen(PORT, HOST, () => {
    console.log(`Lead Prompt Lab ready at http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
