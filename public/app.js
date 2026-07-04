const form = document.getElementById("leadForm");
const statusLine = document.getElementById("statusLine");
const runState = document.getElementById("runState");
const activityWindow = document.getElementById("activityWindow");
const activitySummaryText = document.getElementById("activitySummaryText");
const validationLine = document.getElementById("validationLine");
const logBox = document.getElementById("logBox");
const activityFeed = document.getElementById("activityFeed");
const clearBtn = document.getElementById("clearBtn");
const downloadCurrentBtn = document.getElementById("downloadCurrentBtn");

const STORAGE_KEY = "lead-prompt-lab-settings";
const DOWNLOAD_KEY = "lead-prompt-lab-last-downloaded-result";
let lastDownloadedResult = null;
let currentCsvDownload = null;

const DEFAULT_FORM_VALUES = {
  leadType: "talhos",
  geography: "Portugal",
};

function readForm() {
  const data = new FormData(form);
  const values = Object.fromEntries(data.entries());
  const leadType = String(values.leadType || "leads").trim();
  const geography = String(values.geography || "Portugal").trim();
  values.objective = `Procura o máximo possível de leads de ${leadType} em ${geography}, com resultados extensos e CSV final compatível com Excel.`;
  values.outputName = "leads.csv";
  values.columns = "Nome;Pagina web;Redes sociais;Email;Telefone;Localidade;Distrito;Fontes consultadas;Observacoes";
  return values;
}

function writeForm(values) {
  for (const [key, value] of Object.entries(values || {})) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
}

function downloadFile(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename || "";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function setActivitySummary(text) {
  activitySummaryText.textContent = text || "Aguardando execução";
}

function formatRunState(status) {
  switch (String(status || "").toLowerCase()) {
    case "queued":
    case "starting":
      return "Em espera";
    case "running":
      return "A trabalhar";
    case "completed":
      return "Concluído";
    case "failed":
      return "Falhou";
    default:
      return "Em espera";
  }
}

function setRunState(status) {
  const label = formatRunState(status);
  runState.textContent = label;
  runState.dataset.state = label.toLowerCase();
}

function setCurrentCsvDownload(latest) {
  currentCsvDownload = null;
  if (!downloadCurrentBtn) return;
  const result = latest?.result || latest?.files?.outputFile || "";
  if (!latest?.id || !result) {
    downloadCurrentBtn.disabled = true;
    return;
  }
  const filename = result.split(/[\\/]/).pop() || "leads.csv";
  currentCsvDownload = {
    url: `/api/runs/${latest.id}/files/${encodeURIComponent(filename)}`,
    filename,
  };
  downloadCurrentBtn.disabled = false;
}

function syncActivityScroll() {
  document.body.classList.toggle("activity-scroll", Boolean(activityWindow?.open));
}

function formatLeadCount(latest) {
  const status = String(latest?.status || "").toLowerCase();
  const stats = latest?.aggregateStats || {};
  const valid = Number(stats.kept || 0);
  if (status === "completed") return `${valid} leads válidas`;
  if (status === "failed") return `${valid} leads válidas após validação`;
  return `${valid} leads válidas até agora`;
}

function formatValidationCount(latest) {
  const stats = latest?.aggregateStats || {};
  const rejected = Number(stats.rejectedByValidation || 0);
  const validationErrors = Number(stats.validationErrors || 0);
  if (!rejected && !validationErrors) return "A validação por IA ainda não descartou resultados";
  if (validationErrors) {
    return `IA descartou ${rejected} resultados e registou ${validationErrors} erros de validação`;
  }
  return `IA descartou ${rejected} resultados`;
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  if (statusLine) {
    statusLine.textContent = data.pipelineReady ? "Pipeline pronta" : "Pronto para lançar";
  }

  const latest = data.runs?.[0];
  if (latest) {
    setRunState(latest.status);
    setCurrentCsvDownload(latest);
    if (statusLine && latest.aggregateStats) {
      statusLine.textContent = `${formatRunState(latest.status)}: ${formatLeadCount(latest)}`;
    }
    if (validationLine) {
      validationLine.textContent = formatValidationCount(latest);
    }
    activityFeed.innerHTML = "";
    const events = latest.events || [];
    const rows = events.length ? events : [{ at: "", message: "Aguardando execução" }];
    const newest = rows[rows.length - 1];
    setActivitySummary(newest?.message || "Aguardando execução");
    logBox.textContent = latest.logTail || latest.error || "";
    for (const event of rows.slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = event.at ? `${event.at} · ${event.message}` : event.message;
      activityFeed.appendChild(li);
    }
    if (latest.result && latest.status === "completed") {
      const filename = latest.result.split(/[\\/]/).pop();
      const url = `/api/runs/${latest.id}/files/${encodeURIComponent(filename)}`;
      const downloadedMarker = sessionStorage.getItem(DOWNLOAD_KEY);
      if (lastDownloadedResult !== latest.result && downloadedMarker !== latest.result) {
        lastDownloadedResult = latest.result;
        sessionStorage.setItem(DOWNLOAD_KEY, latest.result);
        downloadFile(url, filename);
      }
    }
  } else {
    setRunState("queued");
    setCurrentCsvDownload(null);
    if (validationLine) {
      validationLine.textContent = "A validação por IA ainda não começou";
    }
    logBox.textContent = "";
    setActivitySummary("Aguardando execução");
    activityFeed.innerHTML = "<li>Aguardando execução</li>";
  }
}

form.addEventListener("input", () => {
  const values = readForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
});
form.addEventListener("change", () => {
  const values = readForm();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = readForm();
  setRunState("starting");
  setActivitySummary("A lançar a tarefa");
  lastDownloadedResult = null;
  sessionStorage.removeItem(DOWNLOAD_KEY);
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const data = await res.json();
  setRunState(data.status);
  await refreshStatus();
});

clearBtn.addEventListener("click", () => {
  for (const [key, value] of Object.entries(DEFAULT_FORM_VALUES)) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
  localStorage.removeItem(STORAGE_KEY);
  setRunState("queued");
  setActivitySummary("Aguardando execução");
  activityFeed.innerHTML = "<li>Aguardando execução</li>";
  logBox.textContent = "";
  activityWindow.open = false;
  syncActivityScroll();
  setCurrentCsvDownload(null);
  if (validationLine) validationLine.textContent = "A validação por IA ainda não começou";
});

downloadCurrentBtn?.addEventListener("click", () => {
  if (!currentCsvDownload) return;
  downloadFile(currentCsvDownload.url, currentCsvDownload.filename);
});

activityWindow?.addEventListener("toggle", syncActivityScroll);
const saved = localStorage.getItem(STORAGE_KEY);
if (saved) {
  const savedValues = JSON.parse(saved);
  writeForm(savedValues);
}

syncActivityScroll();
refreshStatus();
setInterval(refreshStatus, 2500);
