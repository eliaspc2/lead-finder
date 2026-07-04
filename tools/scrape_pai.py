import argparse
import concurrent.futures as cf
import csv
import json
import os
import re
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

from lxml import html


BASE_URL = "https://www.pai.pt/searches"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
}
CSV_COLUMNS = [
    "Nome",
    "Pagina web",
    "Redes sociais",
    "Email",
    "Telefone",
    "Localidade",
    "Distrito",
    "Fontes consultadas",
    "Observacoes",
]


def now_stamp():
    return time.strftime("%H:%M:%S")


def fetch_html(url, retries=3, sleep_s=1.0):
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=20) as resp:
                return resp.read().decode("utf-8", "ignore")
        except HTTPError as exc:
            last_err = exc
            if exc.code == 429:
                time.sleep(6.0 * (attempt + 1))
                continue
            time.sleep(sleep_s * (attempt + 1))
        except (URLError, TimeoutError, OSError) as exc:
            last_err = exc
            time.sleep(sleep_s * (attempt + 1))
    raise last_err


def clean_spaces(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_folded(value):
    import unicodedata

    text = clean_spaces(value).lower()
    return "".join(ch for ch in unicodedata.normalize("NFD", text) if unicodedata.category(ch) != "Mn")


def text_join(nodes):
    parts = []
    for node in nodes:
        if isinstance(node, str):
            txt = clean_spaces(node)
            if txt:
                parts.append(txt)
        else:
            txt = clean_spaces(" ".join(node.xpath(".//text()")))
            if txt:
                parts.append(txt)
    return " | ".join(parts)


def load_response(path):
    if not path:
        return {}
    try:
        if Path(path).exists():
            return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def write_response(path, payload):
    if not path:
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def update_response(path, **patch):
    current = load_response(path)
    current.update(patch)
    current["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    write_response(path, current)


def get_search_url(query, location, page_num):
    params = {
        "search[query]": query,
        "search[ne]": "42.1541,-6.4969",
        "search[sw]": "32.2099,-29.8597",
        "search[center]": "",
        "search[map]": "",
        "search[location_id]": "1",
        "search[category_id]": "",
        "search[tag_id]": "",
        "search[group_id]": "",
        "search[location_value]": location,
        "search[location]": location,
        "commit": "Procurar",
    }
    if page_num != 1:
        params["page"] = str(page_num)
    return f"{BASE_URL}?{urlencode(params)}"


def parse_search_page(page_num, query, location):
    time.sleep(0.4)
    url = get_search_url(query, location, page_num)
    doc = html.fromstring(fetch_html(url))
    cards = doc.xpath('//div[contains(@class,"card card--result")]')
    results = []
    for idx, card in enumerate(cards, start=1):
        link = card.xpath('.//h6[contains(@class,"card-title")]/a[@href] | .//a[@data-trackable-event="click-search-results"]')
        if not link:
            continue
        link = link[0]
        href = link.get("href", "")
        detail_url = urljoin(url, href)
        title = clean_spaces(" ".join(link.xpath(".//text()")))
        category = clean_spaces(" ".join(card.xpath('.//div[contains(@class,"card-metadata")]//text()')))
        description = clean_spaces(" ".join(card.xpath('.//p[contains(@class,"card-description")]//text()')))
        address = clean_spaces(" ".join(card.xpath('.//div[contains(@class,"card-address")]//text()')).replace("\xa0", " "))
        phone_el = card.xpath('.//button[starts-with(@title,"Copiar número:")] | .//a[starts-with(@href,"tel:")]')
        phone = ""
        if phone_el:
            el = phone_el[0]
            phone = el.get("value") or el.get("title", "").replace("Copiar número:", "").strip() or el.get("href", "").replace("tel:", "").strip()
        results.append(
            {
                "search_page": page_num,
                "search_rank": idx,
                "search_url": url,
                "search_title": title,
                "search_category": category,
                "search_description": description,
                "search_address": address,
                "search_phone": phone,
                "detail_url": detail_url,
            }
        )
    next_links = doc.xpath('//a[@rel="next"]/@href')
    has_next = bool(next_links)
    total_text = clean_spaces(" ".join(doc.xpath('//div[contains(@class,"results-title")]//text()')))
    total_match = re.search(r"Encontrámos\s+(\d+)\s+resultado", total_text)
    total_results = int(total_match.group(1)) if total_match else None
    return results, has_next, total_results, url


def parse_detail(url, query, location, search_url):
    time.sleep(0.7)
    doc = html.fromstring(fetch_html(url))
    name = clean_spaces(" ".join(doc.xpath('//h1//text()')) or " ".join(doc.xpath('//title//text()')))
    meta_desc = ""
    meta = doc.xpath('//meta[@name="description"]/@content')
    if meta:
        meta_desc = clean_spaces(meta[0])
    json_ld = {}
    script = doc.xpath('//script[@type="application/ld+json"]/text()')
    for raw in script:
        raw = raw.strip()
        if not raw:
            continue
        try:
            candidate = json.loads(raw)
        except Exception:
            continue
        if isinstance(candidate, dict) and candidate.get("@type") in {"LocalBusiness", "Organization"}:
            json_ld = candidate
            break
    website = ""
    website_link = doc.xpath('//a[contains(normalize-space(.),"Visitar website")]/@href')
    if website_link:
        website = website_link[0]
    email = ""
    email_link = doc.xpath('//a[starts-with(@href,"mailto:")]/@href')
    if email_link:
        email = email_link[0].replace("mailto:", "").strip()
    phones = []
    for href in doc.xpath('//a[starts-with(@href,"tel:")]/@href'):
        phones.append(href.replace("tel:", "").strip())
    for match in re.findall(r"(?:\+?351[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?){3,4}\d{2,4}", doc.text_content()):
        cleaned = clean_spaces(match)
        if cleaned and len(re.sub(r"\D", "", cleaned)) >= 7:
            phones.append(cleaned)
    social_links = []
    for href in doc.xpath('//a[@href]/@href'):
        lowered = href.lower()
        if "paginasamarelas.pt" in lowered or "share" in lowered or "sharer" in lowered:
            continue
        if any(domain in lowered for domain in ("facebook.com", "instagram.com", "linkedin.com", "youtube.com", "tiktok.com", "x.com", "twitter.com")):
            social_links.append(href)
    social_links = sorted(set(social_links))
    address = ""
    if isinstance(json_ld.get("address"), dict):
        address = clean_spaces(
            " ".join(
                filter(
                    None,
                    [
                        json_ld["address"].get("streetAddress", ""),
                        json_ld["address"].get("addressLocality", ""),
                        json_ld["address"].get("addressRegion", ""),
                    ],
                )
            )
        )
    if not address:
        addr_nodes = doc.xpath('//div[contains(@class,"info-directions")]//text()')
        address = clean_spaces(" ".join(addr_nodes))
    address = re.sub(r"\bPortugal\b", "", address, flags=re.I)
    address = clean_spaces(address)

    locality = ""
    district = ""
    if address:
        parts = [part.strip() for part in re.split(r"[,|]", address) if part.strip()]
        if parts:
            locality = parts[-1]
            district = parts[-1]
    if isinstance(json_ld.get("address"), dict):
        locality = json_ld["address"].get("addressLocality", locality) or locality
        district = json_ld["address"].get("addressRegion", district) or district

    row = {
        "Nome": name or clean_spaces(" ".join(doc.xpath('//body//text()'))[:120]),
        "Pagina web": website,
        "Redes sociais": " | ".join(social_links),
        "Email": email,
        "Telefone": phones[0] if phones else str(json_ld.get("telephone", "")).strip(),
        "Localidade": locality,
        "Distrito": district,
        "Fontes consultadas": " | ".join([search_url, url]),
        "Observacoes": " | ".join(
            part for part in [meta_desc and "Meta descrição confirmada.", "Deteção via Páginas Amarelas."] if part
        ),
    }
    return row


def location_matches(row, requested_location):
    requested = normalize_folded(requested_location)
    if not requested or requested == "portugal":
        return True
    haystack = normalize_folded(
        " ".join(
            [
                row.get("Nome", ""),
                row.get("Localidade", ""),
                row.get("Distrito", ""),
                row.get("search_title", ""),
                row.get("search_address", ""),
                row.get("search_description", ""),
            ]
        )
    )
    return requested in haystack


def lead_type_matches(row, query):
    requested = normalize_folded(query)
    haystack = normalize_folded(
        " ".join(
            [
                row.get("Nome", ""),
                row.get("search_title", ""),
                row.get("search_category", ""),
                row.get("search_description", ""),
                row.get("Observacoes", ""),
            ]
        )
    )
    if "barbear" in requested or "barber" in requested:
        if "produto" in haystack or "associacao" in haystack or "associação" in haystack:
            return False
        return any(term in haystack for term in ["barbearia", "barbeiro", "barber", "barbershop"])
    if "talh" in requested or "carn" in requested:
        return any(term in haystack for term in ["talho", "talhos", "carne", "carnes"])
    return True


def row_key(row):
    name = clean_spaces(row.get("Nome", "")).lower()
    website = clean_spaces(row.get("Pagina web", "")).lower()
    email = clean_spaces(row.get("Email", "")).lower()
    phone = re.sub(r"\D", "", clean_spaces(row.get("Telefone", "")))
    locality = clean_spaces(row.get("Localidade", "")).lower()
    if email:
        return f"email:{email}"
    if phone:
        return f"phone:{phone}"
    if website:
        return f"website:{website}|{name}"
    return "|".join(part for part in [name, locality] if part)


def write_csv_header(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
      writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, delimiter=";")
      writer.writeheader()


def append_row(path, row):
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists() and path.stat().st_size > 0
    with path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, delimiter=";")
        if not exists:
            writer.writeheader()
        writer.writerow({col: row.get(col, "") for col in CSV_COLUMNS})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", default="talho")
    parser.add_argument("--location", default="Portugal")
    parser.add_argument("--output", default="leads.csv")
    parser.add_argument("--response-file", default="")
    parser.add_argument("--max-pages", type=int, default=5)
    args = parser.parse_args()

    output = Path(args.output)
    response_file = args.response_file or os.environ.get("LEAD_WORKER_RESPONSE_FILE", "")
    output.parent.mkdir(parents=True, exist_ok=True)
    write_csv_header(output)

    response_seed = {
        "status": "starting",
        "profile": "directories",
        "writtenRows": 0,
        "foundRows": 0,
        "blockers": [],
        "notes": [],
        "csvPath": str(output).replace("\\", "/"),
    }
    write_response(response_file, response_seed)

    pages = []
    total_results = None
    has_next = True
    page_num = 1
    while has_next and page_num <= args.max_pages:
        results, has_next, total, search_url = parse_search_page(page_num, args.query, args.location)
        pages.append((results, search_url))
        if total_results is None and total is not None:
            total_results = total
        if not results:
            break
        page_num += 1

    search_rows = []
    for results, search_url in pages:
        for row in results:
            row["search_url"] = search_url
            search_rows.append(row)

    lock = threading.Lock()
    seen = set()
    stats = {"writtenRows": 0, "foundRows": 0}

    def worker(row):
        try:
            detail = parse_detail(row["detail_url"], args.query, args.location, row.get("search_url", ""))
            merged = dict(row)
            merged.update(detail)
            return merged
        except Exception as exc:
            return {"__error__": f"{row['detail_url']} -> {type(exc).__name__}: {exc}"}

    with cf.ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(worker, row) for row in search_rows]
        for index, future in enumerate(cf.as_completed(futures), start=1):
            result = future.result()
            stats["foundRows"] = index
            if "__error__" in result:
                update_response(response_file, status="running", blockers=[result["__error__"]], foundRows=stats["foundRows"], writtenRows=stats["writtenRows"])
                continue

            key = row_key(result)
            if not key or key in seen:
                continue
            if not lead_type_matches(result, args.query):
                continue
            if not location_matches(result, args.location):
                continue
            seen.add(key)
            with lock:
                append_row(output, result)
                stats["writtenRows"] += 1
            update_response(
                response_file,
                status="running",
                profile="directories",
                writtenRows=stats["writtenRows"],
                foundRows=stats["foundRows"],
                blockers=[],
                notes=[],
                totalResults=total_results,
            )
            if index % 10 == 0:
                print(f"[{now_stamp()}] completed {index}/{len(search_rows)}", flush=True)

    write_response(
        response_file,
        {
            **load_response(response_file),
            "status": "completed",
            "profile": "directories",
            "writtenRows": stats["writtenRows"],
            "foundRows": stats["foundRows"],
            "csvPath": str(output).replace("\\", "/"),
        },
    )
    print(json.dumps({"result_count": stats["writtenRows"], "total_results_reported": total_results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
