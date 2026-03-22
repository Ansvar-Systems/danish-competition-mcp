/**
 * Seed the KFST (Konkurrence- og Forbrugerstyrelsen) database with sample
 * decisions, mergers, and sectors for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["KFST_DB_PATH"] ?? "data/kfst.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface SectorRow { id: string; name: string; name_en: string; description: string; decision_count: number; merger_count: number; }

const sectors: SectorRow[] = [
  { id: "digital_economy", name: "Digital okonomi", name_en: "Digital economy",
    description: "Onlineplatforme, digitale markedspladser, sogemaskiner og app-butikker pa det danske marked.", decision_count: 2, merger_count: 1 },
  { id: "food_retail", name: "Dagligvarehandel", name_en: "Food retail",
    description: "Dagligvarehandel, supermarkeder, grossister og leverandorrelationer i Danmark.", decision_count: 2, merger_count: 1 },
  { id: "energy", name: "Energi", name_en: "Energy",
    description: "El- og gasproduktion, transmission, distribution og handel pa det danske energimarked.", decision_count: 1, merger_count: 2 },
  { id: "financial_services", name: "Finansielle tjenester", name_en: "Financial services",
    description: "Banker, forsikring, betalingslosninger og finansmarkedsinfrastruktur i Danmark.", decision_count: 1, merger_count: 1 },
  { id: "telecommunications", name: "Telekommunikation", name_en: "Telecommunications",
    description: "Mobil, bredbandnd, fastnet og telekommunikationsinfrastruktur i Danmark.", decision_count: 1, merger_count: 1 },
  { id: "healthcare", name: "Sundhedssektor", name_en: "Healthcare",
    description: "Hospitaler, medicinalindustri, medicinsk udstyr og sundhedsforsikring i Danmark.", decision_count: 1, merger_count: 1 },
  { id: "construction", name: "Bygge- og anlae gssektoren", name_en: "Construction",
    description: "Byggematerialer, byggetjenester og ejendomsudvikling i Danmark.", decision_count: 1, merger_count: 0 },
  { id: "media", name: "Medier", name_en: "Media",
    description: "Presse, TV, digitale medier og nyhedstjenester i Danmark.", decision_count: 1, merger_count: 0 },
];

const insertSector = db.prepare("INSERT OR IGNORE INTO sectors (id, name, name_en, description, decision_count, merger_count) VALUES (?, ?, ?, ?, ?, ?)");
for (const s of sectors) { insertSector.run(s.id, s.name, s.name_en, s.description, s.decision_count, s.merger_count); }
console.log(`Inserted ${sectors.length} sectors`);

interface DecisionRow { case_number: string; title: string; date: string; type: string; sector: string; parties: string; summary: string; full_text: string; outcome: string; fine_amount: number | null; gwb_articles: string; status: string; }

const decisions: DecisionRow[] = [
  {
    case_number: "KFST/2022/001",
    title: "Coop Danmark — misbrug af dominerende stilling pa dagligvaremarkedet",
    date: "2022-04-12", type: "abuse_of_dominance", sector: "food_retail",
    parties: JSON.stringify(["Coop Danmark A/S"]),
    summary: "Konkurrence- og Forbrugerstyrelsen undersogte om Coop Danmark misbrugte sin dominerende stilling pa det danske dagligvaremarked gennem loyalitetsrabatter og eksklusivitetsaftaler med leverandorer, der kunne begranse konkurrencen fra udbydere udenfor det traditionelle dagligvaresegment.",
    full_text: "Konkurrence- og Forbrugerstyrelsen (KFST) abnede en undersoegelse af Coop Danmark A/S adfaerd pa det danske dagligvaremarked i henhold til Konkurrencelovens paragraf 11 og Artikel 102 TEUF. Det danske dagligvaremarked er et oligopol domineret af Salling Group (Bilka, Fotex, Netto, Salling), Coop Danmark (Kvickly, SuperBrugsen, Irma, Dagli Brugsen, 365discount) og Aldi og Lidl. KFST undersogte om Coops aftaler med leverandorer indeholdt betingelser, der vanskeliggjorde adgangen for discountforretninger og online dagligvareplatforme til at konkurrere pa gyldige vilkar. Specifikke problemstillinger: (1) Loyalitetsrabatter betinget af at leverandorer ikke matte levere til konkurrerende forhandlere pa mere gunstige vilkar. (2) Mest-gunstigste-klausuler (MFN-klausuler) der sikrede Coop mindst lige sa lave priser som Coops lavest prissatte konkurrenter. (3) Informationsudveksling om konkurrenters indkobspriser via leverandorfaellesskaber. KFST vurderede, at visse af disse aftaler kunne udgore misbrug af dominerende stilling. Coop accepterede at modificere sine leverandoraftaler og fjerne de mest problematiske klausuler. KFST afsluttede sagen med tilsagn.",
    outcome: "cleared_with_conditions", fine_amount: null,
    gwb_articles: JSON.stringify(["paragraf 11 KonkurrenceLoven", "Artikel 102 TEUF"]), status: "final",
  },
  {
    case_number: "KFST/2022/002",
    title: "Byggesektoren — budfusk ved offentlige udbudsprocesser",
    date: "2022-08-25", type: "cartel", sector: "construction",
    parties: JSON.stringify(["MT Hojgaard A/S", "Aarsleff Holding A/S", "NCC Danmark A/S"]),
    summary: "KFST pa alagde boeder til MT Hojgaard, Aarsleff og NCC Danmark for deltagelse i budfusk (bid rigging) ved offentlige udbudsprocesser for anlaegsopgaver. Virksomhederne koordinerede bud og udpegede vindere pa forhand.",
    full_text: "Konkurrence- og Forbrugerstyrelsen afsluttede en undersoegelse af budfusk i den danske byggesektor. KFST og Statsadvokaten for Saerlig Kriminalitet (SSK) samarbejdede om undersoegelsen, der startede med brancheanmeldte overtraedelser. Det konstaterede kartelbud: Virksomhederne deltog i et systematisk system for koordinering af bud ved offentlige udbudsprocesser for anlaegsopgaver. (1) Forud-koordinering — virksomhederne kommunikerede forinden tilbudsfrister om, hvilken virksomhed der skulle vinde det paeldende udbud. (2) Ddaekningsbud — de ovrige deltagere indleverede bevidst ikke-konkurrencedygtige bud for at simulere reel konkurrence. (3) Kompensationsaftaler — tabende parter modtog kompensation i form af underentreprise-kontrakter fra den vindende part. Pavirkte udbud: Vej- og broopgaver, kloakering, havnearbejder og offentlige bygninger i perioden 2015-2021. KFST pa alagde virksomhedsboderne pa i alt 112 millioner DKK. SSK rejste tiltalte mod en ra kke enkeltpersoner for overtraedelse af straffelovens bestemmelser om karteller.",
    outcome: "fine", fine_amount: 15_000_000,
    gwb_articles: JSON.stringify(["paragraf 6 KonkurrenceLoven", "Artikel 101 TEUF"]), status: "appealed",
  },
  {
    case_number: "KFST/2023/001",
    title: "Digitale platforme — markedsundersoegelse",
    date: "2023-06-01", type: "sector_inquiry", sector: "digital_economy",
    parties: JSON.stringify(["Operatorer af digitale platforme pa det danske marked"]),
    summary: "KFST gennemforte en markedsundersoegelse af digitale platforme pa det danske marked, herunder e-handelsplatforme, bookingplatforme og digitale annonceringsmarkeder. Undersoegelsen analyserede konkurrencestrukturen og implikationerne af EU's Digital Markets Act.",
    full_text: "Konkurrence- og Forbrugerstyrelsen igangsatte en markedsundersoegelse af digitale platforme i Danmark i henhold til Konkurrencelovens paragraf 12a. Danmark er en af Europas mest digitaliserede okonomier med en hoej andel af e-handel og digitale tjenester. Undersoegelsen daekte tre omrader: (1) E-handelsplatforme — markedsstrukturen for platforme som Coolshop, Elgiganten.dk og internationale platforme. Undersoegelsen analyserede provisionsstrukturer, rangordningsalgoritmer og brug af handlerdata for at forbedre egen-varesalg. (2) Bookingplatforme for rejser og overnatning — fokus pa Booking.com, Hotels.com og lokale portaler, og disses indvirkning pa hotellers og rejsebureauers muligheder for at konkurrere direkte. (3) Digitale annonceringsmarkeder — det programmatiske annonceokosystem pa det danske marked. KFST fandt, at digitale platforme har saerlige karakteristika der skaber network effects og tippling points. Undersoegelsens konklusioner dannede grundlag for KFST's bidrag til EU's Digital Markets Act (DMA) og til den nationalt fastsatte implementeringsramme.",
    outcome: "cleared", fine_amount: null,
    gwb_articles: JSON.stringify(["paragraf 12a KonkurrenceLoven", "DMA"]), status: "final",
  },
  {
    case_number: "KFST/2023/002",
    title: "Finanssektoren — informationsudveksling om realkreditrenter",
    date: "2023-10-15", type: "cartel", sector: "financial_services",
    parties: JSON.stringify(["Nykredit", "Realkredit Danmark (Danske Bank)", "BRFkredit (Jyske Bank)"]),
    summary: "KFST undersogte om de stoerste danske realkreditinstitutter udvekslede konkurrencefolgsom information om renter og bidragssatser pa realkreditobligationer, hvilket potentielt lette koordination og haeving af priser over for danske boligejere.",
    full_text: "Konkurrence- og Forbrugerstyrelsen gennemforte en undersoegelse af informationsudveksling blandt realkreditinstitutter i Danmark i henhold til Konkurrencelovens paragraf 6 og Artikel 101 TEUF. Det danske realkreditmarked er unikt i europaeisk sammenhang med specialiserede realkreditinstitutter der udsteder realkreditobligationer. De stoerste aktorer — Nykredit, Realkredit Danmark og BRFkredit — har samlet set en dominerende position pa markedet for realkreditlan til private boligejere. KFST undersogte om informationsudveksling, der foregik bade via brancheorganisationen Realkreditraadet og via direkte kontakter, var af en saadan art og detaljeringsgrad at den kunne facilitere koordination af renter og bidragssatser. Spesifikke problemstillinger: (1) Udveksling af fremadrettede oplysninger om planlagte renteaendringer. (2) Koordination af bidragssatser (det gebyr institutter opkraever oven pa obligationsrenten). (3) Timing af prisaendringer der viste hoej korrelation. KFST vurderede, at visse former for informationsudveksling var i strid med konkurrencereglerne. Institutterne accepterede at aendre deres praksis og ophoere med udvalgte former for informationsudveksling.",
    outcome: "cleared_with_conditions", fine_amount: null,
    gwb_articles: JSON.stringify(["paragraf 6 KonkurrenceLoven", "Artikel 101 TEUF"]), status: "final",
  },
  {
    case_number: "KFST/2024/001",
    title: "Sundhedssektor — markedsundersoegelse af privathospitaler",
    date: "2024-02-28", type: "sector_inquiry", sector: "healthcare",
    parties: JSON.stringify(["Private hospitaler og klinikker i Danmark"]),
    summary: "KFST gennemforte en markedsundersoegelse af privathospitaler og speciallaegeklinikker i Danmark. Undersoegelsen analyserede prissaetning, kvalitetskonkurrence, forsikringsselskabernes indflydelse og geografiske konkurrenceforhold.",
    full_text: "Konkurrence- og Forbrugerstyrelsen igangsatte en markedsundersoegelse af det private hospitalssegment i Danmark. Privatsygehussektoren i Danmark er vokset betydeligt i takt med oeget sundhedsforsikringsdaekning og la ngere ventetider i det offentlige sygehusvae sen. Undersoegelsen daekte: (1) Markedsstruktur — antallet og stoerrelsen af private hospitaler og klinikker, herunder nyankomne aktorer og konsolidering i branchen. Goupil, Aleris og Mols Klinikken er eksempler pa stoerre private aktorer. (2) Prissaetning — om priser for elektive indgreb er gennemsigtige for forbrugerne, og om prisdifferentiering mellem patientgrupper (kontant, forsikring, pensions-finansieret) er gennemsigtig. (3) Forsikringsselskabernes rolle — om forsikringsselskabernes forhandlingsstyrke overfor hospitalerne skaber en tilstrae kkelig modvaegt, eller om der eksisterer koordination om priser via forsikringsaftaler. (4) Kvalitetskonkurrence — om markedet fungerer pa en made der stimulerer quality competition, eller om manglende gennemsigtighed haeummer dette. KFST anbefalede oget prisgennemsigtighed og standardiserede kvalitetsindikatorer for privathospitaler.",
    outcome: "cleared", fine_amount: null,
    gwb_articles: JSON.stringify(["paragraf 12a Konkurrencenloven"]), status: "ongoing",
  },
];

const insertDecision = db.prepare("INSERT OR IGNORE INTO decisions (case_number, title, date, type, sector, parties, summary, full_text, outcome, fine_amount, gwb_articles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertDecisionsAll = db.transaction(() => { for (const d of decisions) { insertDecision.run(d.case_number, d.title, d.date, d.type, d.sector, d.parties, d.summary, d.full_text, d.outcome, d.fine_amount, d.gwb_articles, d.status); } });
insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

interface MergerRow { case_number: string; title: string; date: string; sector: string; acquiring_party: string; target: string; summary: string; full_text: string; outcome: string; turnover: number | null; }

const mergers: MergerRow[] = [
  {
    case_number: "KFST/2022/M/001",
    title: "Salling Group / Irma — Forsammenkobling af dagligvarekjeder",
    date: "2022-05-20", sector: "food_retail",
    acquiring_party: "Salling Group A/S", target: "Irma A/S",
    summary: "KFST godkendte med vilkar Salling Group A/S overtagelse af Irma A/S. Fusionen blev godkendt pa vilkar om afyttring af butikker i lokale markeder, hvor de kombinerede markedsandele vaekte konkurrensbetaenkeligheder.",
    full_text: "Konkurrence- og Forbrugerstyrelsen behandlede Salling Group A/S' erhvervelse af Irma A/S fra Coop Danmark. Salling Group er Danmarks stoerste dagligvarekoncern med kjederne Bilka, Fotex, Netto og Salling. Irma er en premium dagligvarekaede med butikker primaert i Kobenhavnsomradet. KFST vurderede transaktionen pa de lokale dagligvaremarkeder. Dagligvaremarkeder er lokale i sin natur, typisk defineret med en korkortid pa 5-10 minutter. I et antal lokale markeder i Kobenhavn og nordsjælland ville overtagelsen af Irma betyde, at Salling Group kom til at drive mere end en butik i det lokale omrade, hvilket ville reducere lokal konkurrence. KFST anvendte SLC-testen (significant lessening of competition). Fusionen blev godkendt med vilkar: Salling Group skulle afyttre 5 Irma-butikker i specifikke lokale markeder til en godkendt kober inden for 9 maneder. KFST sikrede sig, at koberne var uafhaengige og i stand til at drive butikkerne som selvstaenige konkurrerende enheder.",
    outcome: "cleared_with_conditions", turnover: 8_000_000_000,
  },
  {
    case_number: "KFST/2023/M/001",
    title: "Orstered / European Energy — Fusion i vindenergi",
    date: "2023-03-30", sector: "energy",
    acquiring_party: "Orsted A/S", target: "European Energy A/S (havvindaktiver)",
    summary: "KFST godkendte Orsted A/S overtagelse af European Energys havvindaktiver pa den danske og internationale vindenergimarked. Fusionen fik godkendelse i fase 1 efter KFST konstaterede at der ikke er significante horisontale overlap pa de relevante markeder.",
    full_text: "Konkurrence- og Forbrugerstyrelsen behandlede Orsted A/S' erhvervelse af udvalgte havvindaktiver fra European Energy A/S. Orsted er verdens stoerste offshore vindmolleoperator med en sterk position pa de nordeuropaeiske markeder for havvindmoller. European Energy er et dansk vedvarende energiselskab med en portefolje af vind- og solenergiprojekter i og udenfor Danmark. Transaktionen afsattes pa: (1) Havvind i Danmark — planlagte og projekterede havvindprojekter i dansk farvand. (2) Europaeiske vindprojekter — havvindprojekter i Storbritannien, Deutschland og Polen. KFST's analyse: Havvindmarkedet karakteriseres ved projektbaseret konkurrence om licenser og statslige auktioner. De horisontale overlap mellem Orsted og European Energy er begransede, da European Energy primaert har projekter i geografiske omrader og faser (tidlig-stadium-projekter) der komplementerer Orsteds portfulje. KFST vurderede, at fusionen ikke ville medfore en vasentlig begransning af konkurrencen og godkendte den i fase 1 uden vilkar.",
    outcome: "cleared_phase1", turnover: 28_000_000_000,
  },
  {
    case_number: "KFST/2023/M/002",
    title: "TDC / Norlys — Fusion i telekommunikation og energi",
    date: "2023-11-10", sector: "telecommunications",
    acquiring_party: "TDC A/S", target: "Norlys Fiber (fibernet til erhvervskunder)",
    summary: "KFST godkendte TDC A/S overtagelse af Norlys Fiber (erhvervssegmentet). Fusionen fik godkendelse i fase 1 efter en vurdering af, at fusionen ikke skaber konkurrenceproblemer pa erhvervsfiber-markedet, hvor der foreligger tilstraekkelig alternativ konkurrence.",
    full_text: "Konkurrence- og Forbrugerstyrelsen behandlede TDC A/S (YouSee/TDC Erhverv)' erhvervelse af Norlys Fiber A/S' erhvervssegment. TDC er Danmarks stoerste telekommunikationsselskab med netvaerk inden for kobber, fiber og mobil. Norlys er et dansk energi- og telekommunikationsselskab der drivet et extensivt fibernet i Jylland og pa Fyn. Transaktionen fokuserer pa Norlys Fibers erhvervskunder — virksomheder og offentlige institutioner der er koblet op pa Norlys' fibernet. KFST's analyse: (1) Erhvervsfibermarkedet — TDC og Norlys driver parallelle fibernet i visse dele af Danmark. KFST vurderede det relevante geografiske marked for erhvervsfiber som nationalt, idet stoerre erhvervskunder typisk kraever naervaer og support over hele landet. (2) Alternativ konkurrence — markedet for erhvervsfiber inkluderer TDC, Norlys, Stofa, Aura Fiber og i visse omrader Eniig og Andel. (3) Ingen problematiske horisontale overlaps — i de lokale omrader daekket af begge selskaber er der tilstraekkelig restkonkurrence fra andre udbydere. KFST godkendte fusionen i fase 1 uden vilkar.",
    outcome: "cleared_phase1", turnover: 16_000_000_000,
  },
];

const insertMerger = db.prepare("INSERT OR IGNORE INTO mergers (case_number, title, date, sector, acquiring_party, target, summary, full_text, outcome, turnover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertMergersAll = db.transaction(() => { for (const m of mergers) { insertMerger.run(m.case_number, m.title, m.date, m.sector, m.acquiring_party, m.target, m.summary, m.full_text, m.outcome, m.turnover); } });
insertMergersAll();
console.log(`Inserted ${mergers.length} mergers`);

const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
const mergerCount = (db.prepare("SELECT count(*) as cnt FROM mergers").get() as { cnt: number }).cnt;
const sectorCount = (db.prepare("SELECT count(*) as cnt FROM sectors").get() as { cnt: number }).cnt;
console.log("\nDatabase summary:");
console.log(`  Sectors:    ${sectorCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Mergers:    ${mergerCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);
db.close();
