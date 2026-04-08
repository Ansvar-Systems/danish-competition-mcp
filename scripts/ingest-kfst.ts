/**
 * Ingestion crawler for the KFST (Konkurrence- og Forbrugerstyrelsen) MCP server.
 *
 * Scrapes competition decisions, merger control decisions, and sector data
 * from kfst.dk and populates the SQLite database.
 *
 * Data sources:
 *   - KFST sitemap HTML (kfst.dk/sitemap) for decision URL discovery
 *   - Merger listing tables (fusionssager) — yearly pages 2017-2026
 *   - Individual decision pages (raads-og-styrelsesafgoerelser, straffedomme,
 *     vejledende-udtalelser, domme)
 *
 * Usage:
 *   npx tsx scripts/ingest-kfst.ts
 *   npx tsx scripts/ingest-kfst.ts --dry-run
 *   npx tsx scripts/ingest-kfst.ts --resume
 *   npx tsx scripts/ingest-kfst.ts --force
 *   npx tsx scripts/ingest-kfst.ts --max-pages 3
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["KFST_DB_PATH"] ?? "data/kfst.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://kfst.dk";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarKFSTCrawler/1.0 (+https://github.com/Ansvar-Systems/danish-competition-mcp)";

/**
 * Years to scrape for merger listing tables.
 * Current year uses the main listing page; older years use the archive.
 */
const CURRENT_YEAR = new Date().getFullYear();
const MERGER_YEARS_START = 2017;
const MERGER_YEARS_END = CURRENT_YEAR;

/**
 * Decision sub-categories on kfst.dk.
 * Each yields URLs under /konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/
 */
const DECISION_PATH_PREFIXES = [
  "/konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/raads-og-styrelsesafgoerelser/",
  "/konkurrenceforhold/afgoerelser/straffedomme-og-boedevedtagelser/",
  "/konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/vejledende-udtalelser-og-indskaerpelser/",
  "/konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/domme/",
  "/konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/civilretlige-domme/",
  "/konkurrenceforhold/afgoerelser/afgoerelser-paa-konkurrenceomraadet/kendelser-fra-konkurrenceankenaevnet/",
];

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPages = maxPagesArg ? parseInt(maxPagesArg, 10) : Infinity;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  decisionsIngested: number;
  mergersIngested: number;
  errors: string[];
}

interface ParsedDecision {
  case_number: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  fine_amount: number | null;
  kl_articles: string | null;
  status: string;
}

interface ParsedMerger {
  case_number: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiring_party: string | null;
  target: string | null;
  summary: string | null;
  full_text: string;
  outcome: string | null;
  turnover: number | null;
}

interface SectorAccumulator {
  [id: string]: {
    name: string;
    name_en: string | null;
    description: string | null;
    decisionCount: number;
    mergerCount: number;
  };
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "da,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    decisionsIngested: 0,
    mergersIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// URL discovery — scrape the KFST sitemap HTML page
// ---------------------------------------------------------------------------

/**
 * KFST uses an HTML sitemap at /sitemap (not XML).  We parse all <a> links
 * and filter for competition-decision URL patterns.
 */
function isDecisionUrl(href: string): boolean {
  return DECISION_PATH_PREFIXES.some((prefix) => href.includes(prefix));
}

/**
 * Additional filter: individual decision pages have a date-prefixed slug
 * like /2025/20251217-slug.  We reject category/index pages that lack this.
 */
function isIndividualDecisionPage(href: string): boolean {
  // Must contain a YYYY/YYYYMMDD pattern
  return /\/\d{4}\/\d{8}-/.test(href);
}

async function discoverDecisionUrls(): Promise<string[]> {
  console.log("\nDiscovering decision URLs from KFST sitemap...");

  const html = await rateLimitedFetch(`${BASE_URL}/sitemap`);
  if (!html) {
    console.error("[ERROR] Could not fetch KFST sitemap page");
    return [];
  }

  const $ = cheerio.load(html);
  const urls: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    if (isDecisionUrl(fullUrl) && isIndividualDecisionPage(fullUrl)) {
      urls.push(fullUrl);
    }
  });

  const unique = Array.from(new Set(urls));
  console.log(`  Found ${unique.length} decision URLs from sitemap`);
  return unique;
}

/**
 * Discover merger decision URLs from the KFST merger listing tables.
 *
 * Current year: /konkurrenceforhold/fusioner/liste-over-fusionssager
 * Previous years: .../tidligere-aars-fusionssager/fusionssager-YYYY
 *
 * The table has 7 columns.  Column 1 (publication date) and column 7
 * (decision date) often contain <a> links to the full decision page.
 */
async function discoverMergerUrls(): Promise<string[]> {
  console.log("\nDiscovering merger URLs from KFST merger listing tables...");

  const urls: string[] = [];

  // Build list of yearly merger listing pages
  const mergerPages: string[] = [
    `${BASE_URL}/konkurrenceforhold/fusioner/liste-over-fusionssager`,
  ];

  for (
    let year = MERGER_YEARS_START;
    year < MERGER_YEARS_END;
    year++
  ) {
    mergerPages.push(
      `${BASE_URL}/konkurrenceforhold/fusioner/liste-over-fusionssager/tidligere-aars-fusionssager/fusionssager-${year}`,
    );
  }

  for (const pageUrl of mergerPages) {
    console.log(`  Fetching merger listing: ${pageUrl}`);
    const html = await rateLimitedFetch(pageUrl);
    if (!html) {
      console.warn(`  [WARN] Could not fetch ${pageUrl}`);
      continue;
    }

    const $ = cheerio.load(html);

    // Extract all links from table cells that point to decision pages
    $("table tr td a[href]").each((_i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      // Decision links point to /konkurrenceforhold/afgoerelser/...
      if (
        fullUrl.includes("/afgoerelser/") &&
        isIndividualDecisionPage(fullUrl)
      ) {
        urls.push(fullUrl);
      }
    });

    console.log(`    Total merger-linked URLs so far: ${urls.length}`);
  }

  const unique = Array.from(new Set(urls));
  console.log(`  Found ${unique.length} merger-related decision URLs (deduplicated)`);
  return unique;
}

// ---------------------------------------------------------------------------
// Danish date parsing
// ---------------------------------------------------------------------------

const DANISH_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  marts: "03",
  april: "04",
  maj: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  december: "12",
};

/**
 * Parse a Danish date string to ISO format (YYYY-MM-DD).
 * Handles:
 *   - "17. marts 2026" / "3. januar 2025"
 *   - "dd-mm-yyyy" / "dd.mm.yyyy"
 *   - "yyyy-mm-dd" (already ISO)
 *   - "YYYYMMDD" (from URL slugs)
 */
function parseDanishDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // Try "d. mmmm yyyy" (Danish textual date)
  const textMatch = s.match(/(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthName, year] = textMatch;
    const monthNum = DANISH_MONTHS[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // Try dd-mm-yyyy or dd.mm.yyyy
  const dashMatch = s.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (dashMatch) {
    const [, day, month, year] = dashMatch;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  // Try yyyy-mm-dd (already ISO)
  const isoMatch = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  // Try YYYYMMDD (from URL slugs)
  const compactMatch = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Page parsing — extract structured data from individual decision pages
// ---------------------------------------------------------------------------

/**
 * Extract metadata from a KFST decision page.
 *
 * KFST pages show metadata as icon + label pairs:
 *   - Afgoerelse [date]        (hammer icon)
 *   - Sagsnummer [number]      (briefcase icon)
 *   - Lovgrundlag [legal basis] (paragraph icon)
 *
 * The page also has a PDF download link ("Hent afgoerelse").
 */
function extractMetadata(
  $: cheerio.CheerioAPI,
): Record<string, string> {
  const meta: Record<string, string> = {};

  // The full page text for regex extraction
  const pageText = $("main, article, .content, body")
    .first()
    .text()
    .replace(/\s+/g, " ");

  // Sagsnummer (case number): pattern like "24/05032", "26/01906"
  const caseNumMatch = pageText.match(
    /[Ss]agsnummer\s*:?\s*(\d{2}\/\d{3,6})/,
  );
  if (caseNumMatch) {
    meta["sagsnummer"] = caseNumMatch[1]!;
  }

  // Lovgrundlag (legal basis): "§ 12 - Fusionskontrol", "§ 6", "§ 11"
  const legalMatch = pageText.match(
    /[Ll]ovgrundlag\s*:?\s*(§\s*\d+[^.]*?)(?:\s*(?:Sagsnummer|Afgørelse|Hent|$))/,
  );
  if (legalMatch) {
    meta["lovgrundlag"] = legalMatch[1]!.trim();
  }

  // Afgoerelse date: "17. marts 2026"
  const dateMatch = pageText.match(
    /[Aa]fg(?:ø|oe)relse\s*:?\s*(\d{1,2}\.\s*\w+\s+\d{4})/,
  );
  if (dateMatch) {
    meta["dato"] = dateMatch[1]!.trim();
  }

  // PDF download link
  $('a[href*=".pdf"]').each((_i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim().toLowerCase();
    if (
      href &&
      (text.includes("hent") ||
        text.includes("download") ||
        text.includes("afgørelse"))
    ) {
      meta["pdf_url"] = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    }
  });

  // Press release link
  $('a[href*="pressemeddelelse"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) {
      meta["pressemeddelelse_url"] = href.startsWith("http")
        ? href
        : `${BASE_URL}${href}`;
    }
  });

  return meta;
}

/**
 * Extract body text from a KFST decision page.
 *
 * KFST uses a CMS layout.  We try multiple selectors for the main content
 * area, then fall back to paragraph text from the main element.
 */
function extractBodyText($: cheerio.CheerioAPI): string {
  const bodySelectors = [
    "article .content-area",
    "article .rich-text",
    ".page-content .rich-text",
    ".article-body",
    "main article",
    "main .content",
  ];

  for (const sel of bodySelectors) {
    const el = $(sel);
    if (el.length > 0 && el.text().trim().length > 100) {
      return el.text().trim();
    }
  }

  // Fallback: collect paragraphs from main
  const paragraphs: string[] = [];
  $("main p, article p, .content p").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length > 30) paragraphs.push(text);
  });

  if (paragraphs.length > 0) {
    return paragraphs.join("\n\n");
  }

  // Last resort: strip nav/header/footer and grab remaining text
  $("nav, footer, header, .menu, .breadcrumb, script, style, .cookie-banner").remove();
  return $("main, article, .content").text().trim();
}

/**
 * Extract fine amounts from Danish text.
 * Handles: "10 millioner kroner", "112 mio. kr.", "15.000.000 kr."
 */
function extractFineAmount(text: string): number | null {
  const patterns = [
    // "N millioner kroner" / "N mio. kr."
    /([\d.,]+)\s*(?:millioner|mio\.?)\s*(?:danske\s*)?(?:kroner|kr\.?|DKK)/gi,
    // "N milliard(er) kroner"
    /([\d.,]+)\s*milliard(?:er)?\s*(?:danske\s*)?(?:kroner|kr\.?|DKK)/gi,
    // Direct amounts: "15.000.000 kr." / "DKK 15.000.000"
    /(?:DKK|kr\.?)\s*([\d.]+(?:,\d+)?)/gi,
    /([\d.]+(?:,\d+)?)\s*(?:DKK|kr\.?)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let numStr = match[1];

      if (pattern.source.includes("milliard")) {
        numStr = numStr.replace(/\./g, "").replace(",", ".");
        return parseFloat(numStr) * 1_000_000_000;
      }
      if (pattern.source.includes("million") || pattern.source.includes("mio")) {
        numStr = numStr.replace(/\./g, "").replace(",", ".");
        return parseFloat(numStr) * 1_000_000;
      }

      // Direct amount: Danish uses dots as thousands separators
      numStr = numStr.replace(/\./g, "").replace(",", ".");
      const val = parseFloat(numStr);
      if (!isNaN(val) && val > 0) return val;
    }
  }

  return null;
}

/**
 * Extract cited legal articles (Konkurrenceloven, TEUF/TFEU) from text.
 */
function extractLegalArticles(text: string): string[] {
  const articles: string[] = [];
  const seen = new Map<string, boolean>();

  function addArticle(art: string): void {
    if (!seen.has(art)) {
      seen.set(art, true);
      articles.push(art);
    }
  }

  // § N Konkurrenceloven / KL
  const klPattern =
    /§\s*(\d+\s*[a-z]?)\s*(?:(?:,?\s*stk\.?\s*\d+\s*)?(?:i\s+)?)?(?:Konkurrenceloven|konkurrencelov|KL\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = klPattern.exec(text)) !== null) {
    addArticle(`§ ${m[1]!.trim()} Konkurrenceloven`);
  }

  // Standalone § N references in legal basis metadata
  const standalonePara = text.match(
    /§\s*(\d+\s*[a-z]?)\s*-\s*(Fusionskontrol|tilsagnsafg|Karteller|Misbrug)/gi,
  );
  if (standalonePara) {
    for (const match of standalonePara) {
      addArticle(match.trim());
    }
  }

  // Art. 101/102 TEUF / TFEU
  const euPattern = /[Aa]rt(?:ikel)?\.?\s*(101|102)\s*(?:TEUF|TFEU|TEU|EUF)/gi;
  while ((m = euPattern.exec(text)) !== null) {
    addArticle(`Artikel ${m[1]} TEUF`);
  }

  // DMA references
  if (/\bDMA\b|Digital Markets Act/i.test(text)) {
    addArticle("DMA");
  }

  return articles;
}

/**
 * Classify a KFST decision based on its URL path, metadata, and content.
 */
function classifyDecisionType(
  url: string,
  meta: Record<string, string>,
  title: string,
  bodyText: string,
): {
  isMerger: boolean;
  isDecision: boolean;
  type: string | null;
  outcome: string | null;
  status: string;
} {
  const titleLower = title.toLowerCase();
  const lovgrundlag = (meta["lovgrundlag"] ?? "").toLowerCase();
  const allText = `${titleLower} ${bodyText.toLowerCase().slice(0, 3000)}`;
  const urlLower = url.toLowerCase();

  // Merger classification
  const isMerger =
    lovgrundlag.includes("fusionskontrol") ||
    lovgrundlag.includes("§ 12") ||
    urlLower.includes("fusionssager") ||
    titleLower.includes("erhvervelse") ||
    titleLower.includes("fusion") ||
    titleLower.includes("overtagelse") ||
    (titleLower.includes("enekontrol") && !titleLower.includes("misbrug")) ||
    titleLower.includes("joint venture") ||
    titleLower.includes("godkendt") && titleLower.includes("erhvervelse");

  // Decision type
  let type: string | null = null;
  if (
    allText.includes("kartel") ||
    allText.includes("budfusk") ||
    allText.includes("prisaftale") ||
    allText.includes("markedsdeling") ||
    urlLower.includes("straffedomme")
  ) {
    type = "cartel";
  } else if (
    allText.includes("misbrug af dominerende stilling") ||
    allText.includes("misbrug") && allText.includes("dominerende") ||
    allText.includes("margin squeeze") ||
    lovgrundlag.includes("§ 11")
  ) {
    type = "abuse_of_dominance";
  } else if (
    allText.includes("markedsundersøgelse") ||
    allText.includes("markedsundersoegelse") ||
    allText.includes("sektorundersøgelse") ||
    allText.includes("sektoranalyse") ||
    lovgrundlag.includes("§ 12a") ||
    lovgrundlag.includes("§ 12 a")
  ) {
    type = "sector_inquiry";
  } else if (
    allText.includes("tilsagn") ||
    lovgrundlag.includes("tilsagn") ||
    lovgrundlag.includes("§ 16 a")
  ) {
    type = "commitment_decision";
  } else if (isMerger) {
    type = "merger_control";
  } else if (
    urlLower.includes("vejledende-udtalelser") ||
    allText.includes("vejledende udtalelse")
  ) {
    type = "guidance";
  } else if (
    urlLower.includes("kendelser-fra-konkurrenceankenaevnet") ||
    allText.includes("konkurrenceankenævn")
  ) {
    type = "appeal_decision";
  } else if (urlLower.includes("domme") || urlLower.includes("civilretlige")) {
    type = "court_decision";
  } else {
    type = "decision";
  }

  // Outcome classification
  let outcome: string | null = null;
  if (allText.includes("bøde") || allText.includes("boede") || allText.includes("idømt")) {
    outcome = "fine";
  } else if (
    titleLower.includes("godkendt") ||
    titleLower.includes("godkendelse") ||
    allText.includes("er godkendt")
  ) {
    if (allText.includes("fase 2") || allText.includes("fase ii")) {
      outcome = "cleared_phase2";
    } else if (isMerger) {
      outcome = allText.includes("vilkår") || allText.includes("vilkar") || allText.includes("betingelse")
        ? "cleared_with_conditions"
        : "cleared_phase1";
    } else {
      outcome = "cleared";
    }
  } else if (
    allText.includes("afvist") ||
    allText.includes("forbudt") ||
    allText.includes("ikke godkendt")
  ) {
    outcome = "blocked";
  } else if (
    allText.includes("tilsagn") ||
    allText.includes("forpligter sig")
  ) {
    outcome = "cleared_with_conditions";
  } else if (
    allText.includes("indskærpelse") ||
    allText.includes("indskaerpelse")
  ) {
    outcome = "warning";
  }

  // Status: check for appeal/ongoing markers
  let status = "final";
  if (
    allText.includes("anket") ||
    allText.includes("indbragt for") ||
    allText.includes("påklaget") ||
    allText.includes("anken")
  ) {
    status = "appealed";
  } else if (
    allText.includes("igangværende") ||
    allText.includes("pågår") ||
    allText.includes("verserer")
  ) {
    status = "ongoing";
  }

  const isDecision = !isMerger;

  return { isMerger, isDecision, type, outcome, status };
}

/**
 * Map Danish sector references to sector IDs.
 */
function classifySector(
  title: string,
  bodyText: string,
  meta: Record<string, string>,
): string | null {
  const text =
    `${title} ${meta["lovgrundlag"] ?? ""} ${bodyText.slice(0, 2000)}`.toLowerCase();

  const sectorMapping: Array<{ id: string; patterns: string[] }> = [
    {
      id: "digital_economy",
      patterns: [
        "digital",
        "online platform",
        "app store",
        "e-handel",
        "søgemaskine",
        "sogemaskine",
        "annoncering",
        "tech-virksomhed",
      ],
    },
    {
      id: "food_retail",
      patterns: [
        "dagligvare",
        "supermarked",
        "detail",
        "fødevare",
        "levnedsmiddel",
        "discount",
        "købmand",
      ],
    },
    {
      id: "energy",
      patterns: [
        "energi",
        "el-",
        "elforsyning",
        "gas",
        "fjernvarme",
        "vindmølle",
        "vindenergi",
        "vedvarende",
        "solenergi",
        "havvind",
      ],
    },
    {
      id: "financial_services",
      patterns: [
        "bank",
        "realkredit",
        "forsikring",
        "pensions",
        "finansiel",
        "betaling",
        "kreditinstitut",
        "realkreditlan",
      ],
    },
    {
      id: "telecommunications",
      patterns: [
        "telekom",
        "bredbånd",
        "bredbaand",
        "fiber",
        "mobil",
        "telefon",
        "tele ",
        "tdc",
        "fastnet",
      ],
    },
    {
      id: "healthcare",
      patterns: [
        "sundhed",
        "hospital",
        "medicin",
        "læge",
        "laege",
        "apotek",
        "medicinsk",
        "patient",
        "stomi",
      ],
    },
    {
      id: "construction",
      patterns: [
        "bygge",
        "anlæg",
        "anlaeg",
        "entreprenør",
        "entreprenor",
        "byggematerial",
        "ejendom",
        "bolig",
      ],
    },
    {
      id: "media",
      patterns: [
        "medie",
        "presse",
        "tv ",
        "radio",
        "forlag",
        "avis",
        "nyheds",
        "omroep",
      ],
    },
    {
      id: "transport",
      patterns: [
        "transport",
        "luft",
        "fly",
        "færge",
        "shipping",
        "jernbane",
        "bus ",
        "taxi",
        "rederier",
      ],
    },
    {
      id: "agriculture",
      patterns: [
        "landbrug",
        "mejeri",
        "mejeriprodukt",
        "korn",
        "slagteri",
        "gødning",
      ],
    },
    {
      id: "automotive",
      patterns: [
        "bil",
        "automobil",
        "bilhandler",
        "lastbil",
        "bilcenter",
        "autoværk",
      ],
    },
    {
      id: "waste_management",
      patterns: [
        "affald",
        "genbrug",
        "renovation",
        "forbrænding",
      ],
    },
  ];

  for (const { id, patterns } of sectorMapping) {
    for (const p of patterns) {
      if (text.includes(p)) return id;
    }
  }

  return null;
}

/**
 * Extract merger parties from a KFST merger decision title/body.
 *
 * Common KFST title patterns:
 *   - "X erhvervelse af Y er godkendt"
 *   - "X's overtagelse af Y"
 *   - "X og Y etablering af joint venture Z"
 *   - "X erhvervelse af enekontrol over Y er godkendt"
 */
function extractMergerParties(
  title: string,
  bodyText: string,
): { acquiring: string | null; target: string | null } {
  // Pattern: "X erhvervelse af [enekontrol over] Y"
  const acqMatch = title.match(
    /^(.+?)\s+erhvervelse\s+af\s+(?:enekontrol\s+over\s+)?(.+?)(?:\s+er\s+godkendt|\s+godkendelse|\s*$)/i,
  );
  if (acqMatch) {
    return {
      acquiring: cleanPartyName(acqMatch[1]!),
      target: cleanPartyName(acqMatch[2]!),
    };
  }

  // Pattern: "X overtagelse af Y"
  const overMatch = title.match(
    /^(.+?)\s+overtagelse\s+af\s+(.+?)(?:\s+er\s+godkendt|\s+fra\s+|\s*$)/i,
  );
  if (overMatch) {
    return {
      acquiring: cleanPartyName(overMatch[1]!),
      target: cleanPartyName(overMatch[2]!),
    };
  }

  // Pattern: "X og Y joint venture / etablering"
  const jvMatch = title.match(
    /^(.+?)\s+og\s+(.+?)\s+(?:etablering|joint\s*venture)/i,
  );
  if (jvMatch) {
    return {
      acquiring: cleanPartyName(jvMatch[1]!),
      target: cleanPartyName(jvMatch[2]!),
    };
  }

  // Fallback: look in body for "X erhverver/overtager Y"
  const bodyMatch = bodyText.match(
    /(.{3,80}?)\s+(?:erhverver|overtager|erhvervelse)\s+(?:enekontrol\s+over\s+)?(.{3,100}?)(?:\.|,)/i,
  );
  if (bodyMatch) {
    return {
      acquiring: cleanPartyName(bodyMatch[1]!),
      target: cleanPartyName(bodyMatch[2]!),
    };
  }

  return { acquiring: null, target: null };
}

function cleanPartyName(raw: string): string {
  return raw
    .replace(/^(?:Godkendelse\s+(?:af|paa baggrund)\s+.*?(?:af|over)\s+)/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—\s]+/, "")
    .replace(/[-–—\s]+$/, "")
    .trim()
    .slice(0, 200);
}

/**
 * Generate a case number from the URL when metadata extraction fails.
 *
 * URL pattern: .../YYYY/YYYYMMDD-slug
 * We produce: KFST/YYYY/MMDD (derived from the date prefix)
 */
function generateCaseNumber(url: string): string {
  const slugMatch = url.match(/\/(\d{4})\/(\d{8})-/);
  if (slugMatch) {
    const dateStr = slugMatch[2]!;
    const year = dateStr.slice(0, 4);
    const rest = dateStr.slice(4);
    return `KFST/${year}/${rest}`;
  }

  // Fallback: hash of URL
  const slug = url.split("/").pop() ?? "unknown";
  return `KFST-WEB/${slug.slice(0, 60)}`;
}

/**
 * Extract a date from the URL slug (YYYYMMDD prefix).
 */
function extractDateFromUrl(url: string): string | null {
  const match = url.match(/\/\d{4}\/(\d{4})(\d{2})(\d{2})-/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

/**
 * Parse a single KFST decision page.
 */
function parsePage(
  html: string,
  url: string,
): { decision: ParsedDecision | null; merger: ParsedMerger | null } {
  const $ = cheerio.load(html);

  // Extract title
  const title =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim().replace(/\s*\|\s*KFST$/, "").replace(/\s*\|\s*Konkurrence.*$/, "") ||
    "";

  if (!title) {
    return { decision: null, merger: null };
  }

  // Extract metadata
  const meta = extractMetadata($);

  // Extract body text
  const bodyText = extractBodyText($);

  if (!bodyText || bodyText.length < 50) {
    return { decision: null, merger: null };
  }

  // Case number: prefer metadata, fall back to URL-derived
  const caseNumber = meta["sagsnummer"]
    ? `KFST/${meta["sagsnummer"]}`
    : generateCaseNumber(url);

  // Date: prefer metadata, fall back to URL date
  const date =
    parseDanishDate(meta["dato"] ?? "") ?? extractDateFromUrl(url);

  // Classify the decision
  const { isMerger, type, outcome, status } = classifyDecisionType(
    url,
    meta,
    title,
    bodyText,
  );

  // Sector
  const sector = classifySector(title, bodyText, meta);

  // Summary: first 500 characters of body text
  const summary = bodyText
    .slice(0, 500)
    .replace(/\s+/g, " ")
    .trim();

  // Legal articles
  const legalArticles = extractLegalArticles(
    `${meta["lovgrundlag"] ?? ""} ${bodyText}`,
  );

  if (isMerger) {
    const { acquiring, target } = extractMergerParties(title, bodyText);

    return {
      decision: null,
      merger: {
        case_number: caseNumber,
        title,
        date,
        sector,
        acquiring_party: acquiring,
        target,
        summary,
        full_text: bodyText,
        outcome: outcome ?? "pending",
        turnover: null, // Not reliably extractable from KFST HTML
      },
    };
  }

  // Non-merger decision
  const fineAmount = extractFineAmount(bodyText);

  return {
    decision: {
      case_number: caseNumber,
      title,
      date,
      type,
      sector,
      parties: null, // KFST does not list parties in a structured field
      summary,
      full_text: bodyText,
      outcome: outcome ?? (fineAmount ? "fine" : "pending"),
      fine_amount: fineAmount,
      kl_articles:
        legalArticles.length > 0 ? JSON.stringify(legalArticles) : null,
      status,
    },
    merger: null,
  };
}

// ---------------------------------------------------------------------------
// Sector definitions (Danish competition sectors)
// ---------------------------------------------------------------------------

const SECTOR_DEFINITIONS: Record<
  string,
  { name: string; name_en: string; description: string }
> = {
  digital_economy: {
    name: "Digital økonomi",
    name_en: "Digital economy",
    description:
      "Onlineplatforme, digitale markedspladser, søgemaskiner og app-butikker på det danske marked.",
  },
  food_retail: {
    name: "Dagligvarehandel",
    name_en: "Food retail",
    description:
      "Dagligvarehandel, supermarkeder, grossister og leverandørrelationer i Danmark.",
  },
  energy: {
    name: "Energi",
    name_en: "Energy",
    description:
      "El- og gasproduktion, transmission, distribution og handel på det danske energimarked.",
  },
  financial_services: {
    name: "Finansielle tjenester",
    name_en: "Financial services",
    description:
      "Banker, realkredit, forsikring, betalingsløsninger og finansmarkedsinfrastruktur i Danmark.",
  },
  telecommunications: {
    name: "Telekommunikation",
    name_en: "Telecommunications",
    description:
      "Mobil, bredbånd, fastnet og telekommunikationsinfrastruktur i Danmark.",
  },
  healthcare: {
    name: "Sundhedssektor",
    name_en: "Healthcare",
    description:
      "Hospitaler, medicinalindustri, medicinsk udstyr og sundhedsforsikring i Danmark.",
  },
  construction: {
    name: "Bygge- og anlægssektoren",
    name_en: "Construction",
    description:
      "Byggematerialer, byggetjenester og ejendomsudvikling i Danmark.",
  },
  media: {
    name: "Medier",
    name_en: "Media",
    description: "Presse, TV, digitale medier og nyhedstjenester i Danmark.",
  },
  transport: {
    name: "Transport",
    name_en: "Transport",
    description:
      "Luftfart, søfart, jernbane, vejtransport og logistik i Danmark.",
  },
  agriculture: {
    name: "Landbrug",
    name_en: "Agriculture",
    description:
      "Landbrug, mejeriproduktion, slagterier og landbrugsrelateret handel i Danmark.",
  },
  automotive: {
    name: "Automobilsektoren",
    name_en: "Automotive",
    description:
      "Bilhandlere, autoværksteder, lastbiler og bilrelaterede tjenester i Danmark.",
  },
  waste_management: {
    name: "Affaldshåndtering",
    name_en: "Waste management",
    description:
      "Affaldsbehandling, genbrug, forbrænding og miljøtjenester i Danmark.",
  },
};

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Created data directory: ${dir}`);
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log("Deleted existing database (--force)");
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function prepareStatements(db: Database.Database) {
  const insertDecision = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, kl_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertDecision = db.prepare(`
    INSERT INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, kl_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      type = excluded.type,
      sector = excluded.sector,
      parties = excluded.parties,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      fine_amount = excluded.fine_amount,
      kl_articles = excluded.kl_articles,
      status = excluded.status
  `);

  const insertMerger = db.prepare(`
    INSERT OR IGNORE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertMerger = db.prepare(`
    INSERT INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(case_number) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      sector = excluded.sector,
      acquiring_party = excluded.acquiring_party,
      target = excluded.target,
      summary = excluded.summary,
      full_text = excluded.full_text,
      outcome = excluded.outcome,
      turnover = excluded.turnover
  `);

  const upsertSector = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = excluded.decision_count,
      merger_count = excluded.merger_count
  `);

  return {
    insertDecision,
    upsertDecision,
    insertMerger,
    upsertMerger,
    upsertSector,
  };
}

// ---------------------------------------------------------------------------
// Main ingestion pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== KFST Competition Decisions Crawler ===");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Resume:     ${resume}`);
  console.log(`  Force:      ${force}`);
  console.log(`  Max pages:  ${maxPages === Infinity ? "all" : maxPages}`);
  console.log("");

  // Load resume state
  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  // Step 1: Discover URLs
  const decisionUrls = await discoverDecisionUrls();
  const mergerUrls = await discoverMergerUrls();

  // Combine and deduplicate — merger URLs that also appear in the
  // decision list will be parsed from the decision URL (same content)
  const allUrlsSet = new Set(decisionUrls);
  for (const u of mergerUrls) allUrlsSet.add(u);
  let allUrls = Array.from(allUrlsSet);

  // Sort by date (newest first, using the URL date prefix)
  allUrls.sort((a, b) => {
    const dateA = extractDateFromUrl(a) ?? "";
    const dateB = extractDateFromUrl(b) ?? "";
    return dateB.localeCompare(dateA);
  });

  // Apply --max-pages limit
  if (maxPages < allUrls.length) {
    allUrls = allUrls.slice(0, maxPages);
    console.log(`\nLimited to ${maxPages} URLs (--max-pages)`);
  }

  // Filter already-processed URLs (for --resume)
  const urlsToProcess = resume
    ? allUrls.filter((u) => !processedSet.has(u))
    : allUrls;

  console.log(`\nTotal URLs discovered: ${allUrls.length}`);
  console.log(`URLs to process:      ${urlsToProcess.length}`);
  if (resume && allUrls.length !== urlsToProcess.length) {
    console.log(
      `  Skipping ${allUrls.length - urlsToProcess.length} already-processed URLs`,
    );
  }

  if (urlsToProcess.length === 0) {
    console.log("Nothing to process. Exiting.");
    return;
  }

  // Step 2: Initialize database (unless dry run)
  let db: Database.Database | null = null;
  let stmts: ReturnType<typeof prepareStatements> | null = null;

  if (!dryRun) {
    db = initDb();
    stmts = prepareStatements(db);
  }

  // Step 3: Process each URL
  const initialDecisions = state.decisionsIngested;
  const initialMergers = state.mergersIngested;
  let decisionsIngested = state.decisionsIngested;
  let mergersIngested = state.mergersIngested;
  let errors = 0;
  let skipped = 0;

  const sectorCounts: SectorAccumulator = {};

  for (let i = 0; i < urlsToProcess.length; i++) {
    const url = urlsToProcess[i]!;
    const progress = `[${i + 1}/${urlsToProcess.length}]`;

    console.log(`${progress} Fetching: ${url}`);

    const html = await rateLimitedFetch(url);
    if (!html) {
      console.log("  SKIP — could not fetch");
      state.errors.push(`fetch_failed: ${url}`);
      errors++;
      continue;
    }

    try {
      const { decision, merger } = parsePage(html, url);

      if (decision) {
        if (dryRun) {
          console.log(
            `  DECISION: ${decision.case_number} — ${decision.title.slice(0, 80)}`,
          );
          console.log(
            `    type=${decision.type}, sector=${decision.sector}, outcome=${decision.outcome}, fine=${decision.fine_amount}`,
          );
        } else {
          const stmt = force ? stmts!.upsertDecision : stmts!.insertDecision;
          stmt.run(
            decision.case_number,
            decision.title,
            decision.date,
            decision.type,
            decision.sector,
            decision.parties,
            decision.summary,
            decision.full_text,
            decision.outcome,
            decision.fine_amount,
            decision.kl_articles,
            decision.status,
          );
          console.log(`  INSERTED decision: ${decision.case_number}`);
        }

        decisionsIngested++;

        // Track sector counts
        if (decision.sector) {
          if (!sectorCounts[decision.sector]) {
            sectorCounts[decision.sector] = {
              name: decision.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[decision.sector]!.decisionCount++;
        }
      } else if (merger) {
        if (dryRun) {
          console.log(
            `  MERGER: ${merger.case_number} — ${merger.title.slice(0, 80)}`,
          );
          console.log(
            `    sector=${merger.sector}, outcome=${merger.outcome}, acquiring=${merger.acquiring_party?.slice(0, 40)}`,
          );
        } else {
          const stmt = force ? stmts!.upsertMerger : stmts!.insertMerger;
          stmt.run(
            merger.case_number,
            merger.title,
            merger.date,
            merger.sector,
            merger.acquiring_party,
            merger.target,
            merger.summary,
            merger.full_text,
            merger.outcome,
            merger.turnover,
          );
          console.log(`  INSERTED merger: ${merger.case_number}`);
        }

        mergersIngested++;

        // Track sector counts
        if (merger.sector) {
          if (!sectorCounts[merger.sector]) {
            sectorCounts[merger.sector] = {
              name: merger.sector,
              name_en: null,
              description: null,
              decisionCount: 0,
              mergerCount: 0,
            };
          }
          sectorCounts[merger.sector]!.mergerCount++;
        }
      } else {
        console.log("  SKIP — could not parse (no title or insufficient text)");
        skipped++;
      }

      // Save state periodically (every 25 URLs)
      state.processedUrls.push(url);
      state.decisionsIngested = decisionsIngested;
      state.mergersIngested = mergersIngested;

      if ((i + 1) % 25 === 0) {
        saveState(state);
        console.log(`  [STATE] Saved progress at ${i + 1} URLs`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] Parsing failed for ${url}: ${message}`);
      state.errors.push(`parse_error: ${url} — ${message}`);
      errors++;
    }
  }

  // Step 4: Insert/update sectors
  if (!dryRun && db && stmts) {
    console.log("\nUpdating sector table...");
    const sectorTransaction = db.transaction(() => {
      for (const [id, counts] of Object.entries(sectorCounts)) {
        const def = SECTOR_DEFINITIONS[id];
        stmts!.upsertSector.run(
          id,
          def?.name ?? id,
          def?.name_en ?? null,
          def?.description ?? null,
          counts.decisionCount,
          counts.mergerCount,
        );
      }

      // Also insert any predefined sectors that had zero hits
      for (const [id, def] of Object.entries(SECTOR_DEFINITIONS)) {
        if (!sectorCounts[id]) {
          stmts!.upsertSector.run(id, def.name, def.name_en, def.description, 0, 0);
        }
      }
    });
    sectorTransaction();
    console.log(
      `  Inserted/updated ${Object.keys(sectorCounts).length} active sectors + ${Object.keys(SECTOR_DEFINITIONS).length - Object.keys(sectorCounts).length} empty sectors`,
    );
  }

  // Step 5: Final state save
  saveState(state);

  // Step 6: Summary
  const decisionCount = !dryRun && db
    ? (
        db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
          cnt: number;
        }
      ).cnt
    : decisionsIngested;

  const mergerCount = !dryRun && db
    ? (
        db.prepare("SELECT count(*) as cnt FROM mergers").get() as {
          cnt: number;
        }
      ).cnt
    : mergersIngested;

  const sectorCount = !dryRun && db
    ? (
        db.prepare("SELECT count(*) as cnt FROM sectors").get() as {
          cnt: number;
        }
      ).cnt
    : Object.keys(sectorCounts).length;

  console.log("\n=== Ingestion Complete ===");
  console.log(`  Decisions ingested (this run): ${decisionsIngested - initialDecisions}`);
  console.log(`  Mergers ingested (this run):   ${mergersIngested - initialMergers}`);
  console.log(`  Errors:                        ${errors}`);
  console.log(`  Skipped:                       ${skipped}`);
  console.log("");
  console.log("Database totals:");
  console.log(`  Decisions: ${decisionCount}`);
  console.log(`  Mergers:   ${mergerCount}`);
  console.log(`  Sectors:   ${sectorCount}`);
  console.log(`\nState saved to: ${STATE_FILE}`);

  if (state.errors.length > 0) {
    console.log(`\nErrors encountered (${state.errors.length}):`);
    for (const e of state.errors.slice(-20)) {
      console.log(`  - ${e}`);
    }
  }

  if (db) {
    db.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
