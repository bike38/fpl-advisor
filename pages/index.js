import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";

const POS_COLOR = { GK: "#F2C230", DEF: "#00FF87", MID: "#B983FF", FWD: "#E90052" };
const DEFAULT_WEIGHTS = { form: 0.25, value: 0.15, fixture: 0.15, start: 0.2, news: 0.15 };
const LS_KEY = "fpl_advisor_state_v1";
const NEWS_OPTIONS = [
  { v: "1", label: "Pozitivne vesti" },
  { v: "0", label: "Bez vesti" },
  { v: "-1", label: "Blaga sumnja" },
  { v: "-2", label: "Upitan za start" },
  { v: "-3", label: "Verovatno van tima" },
];
const emptyManual = { name: "", pos: "MID", team: "", price: "", ownership: "0", form: "0", total: "0", fdr: "3", startProb: "90", newsImpact: "0", newsNote: "" };

function norm(val, min, max, invert = false) {
  if (max === min) return 50;
  const t = ((val - min) / (max - min)) * 100;
  return invert ? 100 - t : t;
}

// Startuje na osnovu startProb; vest se pretvara u kaznu/bonus na osnovu statusa.
function newsImpactFromPlayer(p) {
  if (p.status === "i" || p.status === "s" || p.status === "u") return -3;
  if (p.startProb < 50) return -2;
  if (p.startProb < 90) return -1;
  return 0;
}

function computeScores(players, weights, overrides) {
  if (!players.length) return [];
  // Apply manual overrides (startProb / newsImpact / newsNote / status / setPiece / newSigning) on top of API data.
  const merged = players.map((p) => {
    const o = overrides[p.id] || {};
    const status = o.status || (o.owned ? "owned" : "none"); // backward-compat with old boolean
    return {
      ...p,
      startProb: o.startProb !== undefined && o.startProb !== "" ? Number(o.startProb) : p.startProb,
      manualNewsImpact: o.newsImpact !== undefined && o.newsImpact !== "" ? Number(o.newsImpact) : null,
      newsNoteOverride: o.newsNote || "",
      ownStatus: status,
      owned: status === "owned",
      watch: status === "watch",
      setPiece: !!o.setPiece,
      newSigning: !!o.newSigning,
    };
  });
  const forms = merged.map((p) => p.form);
  const values = merged.map((p) => (p.price > 0 ? p.total / p.price : 0));
  const fdrs = merged.map((p) => p.fdr);
  const fMin = Math.min(...forms), fMax = Math.max(...forms);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const dMin = Math.min(...fdrs), dMax = Math.max(...fdrs);

  return merged.map((p) => {
    const value = p.price > 0 ? p.total / p.price : 0;
    const formScore = norm(p.form, fMin, fMax);
    const valueScore = norm(value, vMin, vMax);
    const fixtureScore = norm(p.fdr, dMin, dMax, true);
    const startScore = Math.max(0, Math.min(100, p.startProb));
    const impact = p.manualNewsImpact !== null ? p.manualNewsImpact : newsImpactFromPlayer(p);
    const newsScore = Math.max(0, Math.min(100, 50 + impact * 15));
    const differentialBonus = p.ownership < 10 ? 4 : 0;
    // Izvođač penala/kornera je pouzdaniji izvor bonus poena - fiksni bonus nezavisan od forme.
    const setPieceBonus = p.setPiece ? 6 : 0;
    // Novo pojačanje bez potvrđene nailed minutaže - blaga kazna dok ne dokaže mesto u timu (startProb visok gasi kaznu).
    const newSigningPenalty = p.newSigning && p.startProb < 90 ? -8 : 0;
    const raw =
      formScore * weights.form + valueScore * weights.value + fixtureScore * weights.fixture +
      startScore * weights.start + newsScore * weights.news + differentialBonus + setPieceBonus + newSigningPenalty;
    // Kapiten se bira svako kolo posebno na osnovu OČEKIVANOG UČINKA tog kola - ne na osnovu
    // cene/vrednosti (valueScore) ni koliko je "diferencijalan" u odnosu na rivale (differentialBonus).
    // To dvoje ima smisla pri kupovini igrača, ali je irelevantno, pa i pogrešno, za kapitensku odluku.
    const captainRaw = formScore * 0.35 + fixtureScore * 0.30 + startScore * 0.20 + newsScore * 0.15 + setPieceBonus + newSigningPenalty;
    const captainScore = Math.max(0, Math.min(100, captainRaw));
    return { ...p, value, formScore, valueScore, fixtureScore, startScore, newsScore, captainScore, score: Math.max(0, Math.min(100, raw)) };
  });
}

const FEATURE_KEYS = ["formScore", "valueScore", "fixtureScore", "startScore", "newsScore"];
const FEATURE_LABELS = {
  formScore: "Forma", valueScore: "Vrednost", fixtureScore: "Raspored",
  startScore: "Verovatnoća starta", newsScore: "Vesti / status",
};

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-9) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-9 ? 0 : row[n] / row[i]));
}

function regressWeights(records) {
  const keys = FEATURE_KEYS;
  const size = keys.length + 1;
  const X = records.map((r) => [1, ...keys.map((k) => r[k])]);
  const y = records.map((r) => r.actual);
  const XtX = Array.from({ length: size }, () => Array(size).fill(0));
  const Xty = Array(size).fill(0);
  for (let i = 0; i < records.length; i++) {
    for (let a = 0; a < size; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < size; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const coef = solveLinear(XtX, Xty);
  const coefs = coef.slice(1);
  const total = coefs.reduce((s, c) => s + Math.abs(c), 0);
  if (total < 1e-6) return null;
  const targetSum = 0.9;
  const floor = 0.03;
  const raw = coefs.map((c) => Math.max(floor, (c / total) * targetSum));
  return { form: raw[0], value: raw[1], fixture: raw[2], start: raw[3], news: raw[4] };
}

function correlation(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

export default function Home() {
  const [rawPlayers, setRawPlayers] = useState([]);
  const [newsMap, setNewsMap] = useState({});
  const [overrides, setOverrides] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [fixtureTicker, setFixtureTicker] = useState({});
  const [setPieceNotes, setSetPieceNotes] = useState([]);
  const [chips, setChips] = useState({
    wildcard1: { gw: "", used: false }, wildcard2: { gw: "", used: false },
    freehit1: { gw: "", used: false }, freehit2: { gw: "", used: false },
    benchboost1: { gw: "", used: false }, benchboost2: { gw: "", used: false },
    triplecaptain1: { gw: "", used: false }, triplecaptain2: { gw: "", used: false },
  });
  const [tab, setTab] = useState("recommend");
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [history, setHistory] = useState([]);
  const [gwInput, setGwInput] = useState("1");
  const [suggestedWeights, setSuggestedWeights] = useState(null);
  const [manualPlayers, setManualPlayers] = useState([]);
  const [manualForm, setManualForm] = useState(emptyManual);
  const [csvText, setCsvText] = useState("");
  const [csvError, setCsvError] = useState("");
  const [csvInfo, setCsvInfo] = useState("");
  const [teamHistory, setTeamHistory] = useState({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [newsLoading, setNewsLoading] = useState(false);
  const [watchPosTab, setWatchPosTab] = useState("ALL");

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (saved.overrides) setOverrides(saved.overrides);
      if (saved.history) setHistory(saved.history);
      if (saved.weights) setWeights(saved.weights);
      if (saved.manualPlayers) setManualPlayers(saved.manualPlayers);
      if (saved.chips) setChips((prev) => ({ ...prev, ...saved.chips }));
    } catch {}
    loadData();
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ overrides, history, weights, manualPlayers, chips }));
  }, [overrides, history, weights, manualPlayers]);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/fpl-data");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRawPlayers(data.players);
      setFetchedAt(data.fetchedAt);
      setFixtureTicker(data.fixtureTicker || {});
      setSetPieceNotes(data.setPieceNotes || []);

      // Keširaj prevode vesti po danu - AI se poziva najviše jednom dnevno, ne pri svakom refresh-u.
      const today = new Date().toISOString().slice(0, 10);
      const cacheKey = "fpl_news_cache_v1";
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey) || "{}");
        if (cached.date === today && cached.map) {
          setNewsMap(cached.map);
          return;
        }
      } catch {}
      await refreshNews(data.players, cacheKey, today);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshNews(playersList, cacheKey, today) {
    const source = playersList || rawPlayers;
    // Sigurnosna kočnica: šalji najviše 40 najbitnijih (najvlasničkih) igrača po pozivu,
    // da trošak po pozivu bude predvidiv čak i ako ima mnogo vesti u isto vreme.
    const withNews = source
      .filter((p) => p.rawNews)
      .sort((a, b) => b.ownership - a.ownership)
      .slice(0, 40);
    if (!withNews.length) return;
    setNewsLoading(true);
    try {
      const newsRes = await fetch("/api/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ players: withNews }),
      });
      const newsData = await newsRes.json();
      const map = {};
      (newsData.translated || []).forEach((n) => { map[n.id] = n.summary; });
      setNewsMap(map);
      const key = cacheKey || "fpl_news_cache_v1";
      const dateKey = today || new Date().toISOString().slice(0, 10);
      localStorage.setItem(key, JSON.stringify({ date: dateKey, map }));
    } finally {
      setNewsLoading(false);
    }
  }

  const allPlayers = useMemo(() => [...rawPlayers, ...manualPlayers], [rawPlayers, manualPlayers]);
  const scored = useMemo(() => computeScores(allPlayers, weights, overrides), [allPlayers, weights, overrides]);

  const filtered = useMemo(() => {
    return scored.filter((p) => {
      if (posFilter !== "ALL" && p.pos !== posFilter) return false;
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.webName.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [scored, posFilter, search]);

  const buyCandidates = useMemo(
    () => scored.filter((p) => !p.owned).sort((a, b) => b.score - a.score).slice(0, 10),
    [scored]
  );
  const sellCandidates = useMemo(
    () => scored.filter((p) => p.owned).sort((a, b) => a.score - b.score),
    [scored]
  );
  const myTeam = useMemo(() => scored.filter((p) => p.owned).sort((a, b) => b.score - a.score), [scored]);
  const watchlist = useMemo(() => scored.filter((p) => p.watch).sort((a, b) => b.score - a.score), [scored]);

  useEffect(() => {
    if (tab === "myteam" && myTeam.length) loadTeamHistory(myTeam);
    if (tab === "watchlist" && watchlist.length) loadTeamHistory(watchlist);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function cycleStatus(id) {
    setOverrides((prev) => {
      const cur = (prev[id] && prev[id].status) || "none";
      const next = cur === "none" ? "owned" : cur === "owned" ? "watch" : "none";
      return { ...prev, [id]: { ...prev[id], status: next, owned: undefined } };
    });
  }

  function toggleStarting(id, currentlyStarting) {
    setOverrideField(id, "starting", !currentlyStarting);
  }

  // Automatski predlaže 4-4-2 raspored po skoru, uz poštovanje ručnih izmena (klik na igrača).
  function computeFormation(teamList, overridesMap) {
    const byPos = { GK: [], DEF: [], MID: [], FWD: [] };
    teamList.forEach((p) => { if (byPos[p.pos]) byPos[p.pos].push(p); });
    Object.values(byPos).forEach((arr) => arr.sort((a, b) => b.score - a.score));
    const target = { GK: 1, DEF: 4, MID: 4, FWD: 2 };
    const startingIds = new Set();
    Object.keys(target).forEach((pos) => {
      byPos[pos].slice(0, target[pos]).forEach((p) => startingIds.add(p.id));
    });
    teamList.forEach((p) => {
      const o = overridesMap[p.id];
      if (o && o.starting === true) startingIds.add(p.id);
      if (o && o.starting === false) startingIds.delete(p.id);
    });
    const starting = teamList.filter((p) => startingIds.has(p.id));
    const bench = teamList.filter((p) => !startingIds.has(p.id));
    return { starting, bench };
  }

  async function loadTeamHistory(players) {
    const ids = players.map((p) => p.id).filter((id) => /^\d+$/.test(String(id)));
    if (!ids.length) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/player-history?ids=${ids.join(",")}`);
      const data = await res.json();
      const map = {};
      (data.results || []).forEach((r) => { map[r.id] = r.history; });
      setTeamHistory((prev) => ({ ...prev, ...map }));
    } catch {
      // tiho ignorišemo - istorija nije kritična za rad ostatka aplikacije
    } finally {
      setHistoryLoading(false);
    }
  }

  function setOverrideField(id, field, val) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }));
  }

  function addManualPlayer() {
    if (!manualForm.name.trim()) return;
    setManualPlayers((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        name: manualForm.name.trim(),
        webName: manualForm.name.trim(),
        pos: manualForm.pos,
        team: manualForm.team.trim().toUpperCase() || "—",
        price: parseFloat(manualForm.price) || 0,
        ownership: parseFloat(manualForm.ownership) || 0,
        form: parseFloat(manualForm.form) || 0,
        total: parseFloat(manualForm.total) || 0,
        fdr: parseInt(manualForm.fdr) || 3,
        startProb: parseFloat(manualForm.startProb) || 90,
        status: "a",
        rawNews: "",
      },
    ]);
    setManualForm(emptyManual);
  }

  function removeManualPlayer(id) {
    setManualPlayers((prev) => prev.filter((p) => p.id !== id));
  }

  // Uklanja ručno dodate igrače koji se zapravo poklapaju sa nekim ko je već stigao
  // preko FPL API-ja (npr. "Bruno Fernandes" ručno vs "B.Fernandes" iz API-ja) -
  // pre brisanja, prebacuje sve override podatke (star/vesti/status) na pravi zapis.
  function cleanupDuplicates() {
    let removedCount = 0;
    setManualPlayers((prevManual) => {
      const stillManual = [];
      const overrideMoves = {};
      prevManual.forEach((mp) => {
        const realMatch = rawPlayers.find((rp) => namesMatch(rp.webName, mp.name) || namesMatch(rp.name, mp.name));
        if (realMatch) {
          removedCount++;
          const mpOverride = overrides[mp.id];
          if (mpOverride) overrideMoves[realMatch.id] = { ...overrides[realMatch.id], ...mpOverride };
        } else {
          stillManual.push(mp);
        }
      });
      if (Object.keys(overrideMoves).length) {
        setOverrides((prevOv) => ({ ...prevOv, ...overrideMoves }));
      }
      return stillManual;
    });
    setCsvInfo(removedCount > 0 ? `Uklonjeno ${removedCount} duplikata.` : "Nema pronađenih duplikata.");
  }

// Poredi imena fleksibilno: tačno poklapanje ILI poklapanje po prezimenu (poslednja reč),
// jer FPL API koristi skraćena imena (npr. "B.Fernandes", "Thiago") koja se ne poklapaju
// slovo-po-slovo sa punim imenom koje neko unese ručno (npr. "Bruno Fernandes", "Igor Thiago").
function namesMatch(a, b) {
  if (!a || !b) return false;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return true;
  const stripDot = (s) => s.replace(/^[a-z]\./, "").trim(); // "b.fernandes" -> "fernandes"
  const lastWord = (s) => stripDot(s).split(/\s+/).filter(Boolean).pop() || "";
  const la = lastWord(na);
  const lb = lastWord(nb);
  if (la && lb && la === lb) return true;
  // Jedno ime sadrži drugo kao podniz (npr. "Igor Thiago" sadrži "Thiago")
  if (stripDot(na).includes(lb) || stripDot(nb).includes(la)) return true;
  return false;
}

function findMatch(pool, rowName) {
  return pool.find((p) => namesMatch(p.webName, rowName) || namesMatch(p.name, rowName));
}

  function parseCsv() {
    setCsvError("");
    setCsvInfo("");
    if (!csvText.trim()) return;
    Papa.parse(csvText.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (res) => {
        let matched = 0, added = 0;
        const newOverrides = {};
        const newManual = [];
        res.data.forEach((row, i) => {
          const rowName = (row.name || "").trim();
          if (!rowName) return;
          const existing = findMatch(allPlayers, rowName);
          if (existing) {
            const isOwned = String(row.owned).trim().toLowerCase() === "true" || String(row.owned).trim() === "1" || (overrides[existing.id] || {}).owned;
            newOverrides[existing.id] = {
              ...(overrides[existing.id] || {}),
              startProb: row.startprob !== undefined && row.startprob !== "" ? row.startprob : undefined,
              newsImpact: row.newsimpact !== undefined && row.newsimpact !== "" ? row.newsimpact : undefined,
              newsNote: row.newsnote || undefined,
              status: isOwned ? "owned" : (overrides[existing.id] || {}).status,
              owned: isOwned,
              setPiece: row.setpiece !== undefined ? (String(row.setpiece).trim().toLowerCase() === "true" || row.setpiece === "1") : (overrides[existing.id] || {}).setPiece,
              newSigning: row.newsigning !== undefined ? (String(row.newsigning).trim().toLowerCase() === "true" || row.newsigning === "1") : (overrides[existing.id] || {}).newSigning,
            };
            matched++;
          } else {
            newManual.push({
              id: `manual-${Date.now()}-${i}`,
              name: rowName, webName: rowName,
              pos: (row.pos || "MID").trim().toUpperCase(),
              team: (row.team || "—").trim().toUpperCase(),
              price: parseFloat(row.price) || 0,
              ownership: parseFloat(row.ownership) || 0,
              form: parseFloat(row.form) || 0,
              total: parseFloat(row.total) || 0,
              fdr: parseInt(row.fdr) || 3,
              startProb: row.startprob !== undefined ? parseFloat(row.startprob) : 90,
              status: "a", rawNews: "",
            });
            added++;
          }
        });
        setOverrides((prev) => ({ ...prev, ...newOverrides }));
        setManualPlayers((prev) => [...prev, ...newManual]);
        setCsvInfo(`Ažurirano ${matched} postojećih igrača, dodato ${added} novih.`);
        setCsvText("");
      },
      error: () => setCsvError("Greška pri parsiranju CSV-a."),
    });
  }

  function saveSnapshot() {
    const gw = parseInt(gwInput) || 0;
    const logFields = (p) => ({
      formScore: p.formScore, valueScore: p.valueScore, fixtureScore: p.fixtureScore,
      startScore: p.startScore, newsScore: p.newsScore,
    });
    const buyLogs = buyCandidates.map((p) => ({
      hid: `${Date.now()}-b-${p.id}`, id: p.id, gw, name: p.webName, pos: p.pos, type: "buy",
      score: p.score, ...logFields(p), actual: null,
    }));
    const sellLogs = sellCandidates.map((p) => ({
      hid: `${Date.now()}-s-${p.id}`, id: p.id, gw, name: p.webName, pos: p.pos, type: "sell",
      score: p.score, ...logFields(p), actual: null,
    }));
    setHistory((prev) => [...prev, ...buyLogs, ...sellLogs]);
    setTab("calibrate");
  }

  function setActual(hid, val) {
    const n = parseFloat(val);
    setHistory((prev) => prev.map((h) => (h.hid === hid ? { ...h, actual: isNaN(n) ? null : n } : h)));
  }

  // Umesto ručnog kucanja poena, povlači STVARNE rezultate direktno sa FPL sajta
  // (isti besplatni endpoint kao "Moj tim") i sam popuni "actual" gde nedostaje.
  async function autoFillActuals() {
    const pending = history.filter((h) => h.actual === null && h.id && /^\d+$/.test(String(h.id)));
    const uniqueIds = [...new Set(pending.map((h) => h.id))];
    if (!uniqueIds.length) {
      setCsvInfo("Nema ničega za povlačenje — ili su svi popunjeni, ili nedostaje ID igrača (stariji unosi pre ove opcije).");
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/player-history?ids=${uniqueIds.join(",")}`);
      const data = await res.json();
      const map = {};
      (data.results || []).forEach((r) => { map[r.id] = r.history; });
      let filled = 0;
      setHistory((prev) => prev.map((h) => {
        if (h.actual !== null || !h.id) return h;
        const hist = map[h.id] || [];
        const match = hist.find((x) => x.gw === h.gw);
        if (match) { filled++; return { ...h, actual: match.points }; }
        return h;
      }));
      setCsvInfo(`Automatski popunjeno: ${filled} od ${pending.length}. Ostalo ručno je ili kolo koje još nije odigrano, ili stariji unos bez sačuvanog ID-a.`);
    } catch (e) {
      setCsvInfo("Greška pri povlačenju stvarnih rezultata.");
    } finally {
      setHistoryLoading(false);
    }
  }

  function removeHistoryEntry(hid) {
    setHistory((prev) => prev.filter((h) => h.hid !== hid));
  }

  const withActual = useMemo(() => history.filter((h) => h.actual !== null), [history]);

  const calibStats = useMemo(() => {
    if (withActual.length < 2) return null;
    const buyActuals = withActual.filter((h) => h.type === "buy").map((h) => h.actual);
    const sellActuals = withActual.filter((h) => h.type === "sell").map((h) => h.actual);
    const buyAvg = buyActuals.length ? buyActuals.reduce((a, b) => a + b, 0) / buyActuals.length : null;
    const sellAvg = sellActuals.length ? sellActuals.reduce((a, b) => a + b, 0) / sellActuals.length : null;
    const corr = correlation(withActual.map((h) => h.score), withActual.map((h) => h.actual));
    return { buyAvg, sellAvg, corr, n: withActual.length };
  }, [withActual]);

  const featureCorrelations = useMemo(() => {
    if (withActual.length < 3) return null;
    const actuals = withActual.map((h) => h.actual);
    return FEATURE_KEYS.map((key) => ({
      key, label: FEATURE_LABELS[key],
      corr: correlation(withActual.map((h) => h[key]), actuals),
    }));
  }, [withActual]);

  function runAutoCalibrate() {
    if (withActual.length < 6) return;
    setSuggestedWeights(regressWeights(withActual));
  }

  function applySuggestedWeights() {
    if (suggestedWeights) {
      setWeights(suggestedWeights);
      setSuggestedWeights(null);
    }
  }

  async function explainAI() {
    setAiLoading(true);
    setAiText("");
    try {
      const pack = (p) => ({
        name: p.name, pos: p.pos, team: p.team, price: p.price, form: p.form,
        ownership: p.ownership, fdr: p.fdr, startProb: p.startProb,
        newsSummary: newsMap[p.id] || null, score: Math.round(p.score),
      });
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buy: buyCandidates.map(pack), sell: sellCandidates.slice(0, 5).map(pack) }),
      });
      const data = await res.json();
      setAiText(data.text || data.error || "Nema odgovora.");
    } catch (e) {
      setAiText("Greška: " + String(e));
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div style={{ fontFamily: "'Inter','Segoe UI',sans-serif", minHeight: "100vh", background: "#0d0620", color: "#f4f1fb", padding: 20 }}>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 26, fontWeight: 900, margin: 0 }}>⚽ FPL Transfer Savetnik</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => refreshNews()} disabled={newsLoading} style={{ ...btnStyle, background: "#B983FF" }} title="Ovo poziva AI i troši kredit">
              {newsLoading ? "Prevodim..." : "🌐 Osveži vesti (AI)"}
            </button>
            <button onClick={loadData} disabled={loading} style={btnStyle}>
              {loading ? "Osvežavam..." : "🔄 Osveži podatke"}
            </button>
          </div>
        </div>
        {fetchedAt && <p style={{ color: "#8a80ab", fontSize: 12, marginTop: 0 }}>Poslednje osveženo: {new Date(fetchedAt).toLocaleString("sr-RS")} · vesti se prevode najviše jednom dnevno (keš)</p>}
        {error && <p style={{ color: "#ff8a8a" }}>Greška: {error}</p>}

        <div style={{ display: "flex", gap: 6, margin: "14px 0", flexWrap: "wrap" }}>
          {[["recommend", "Preporuke"], ["myteam", `Moj tim (${myTeam.length})`], ["watchlist", `Pratim (${watchlist.length})`], ["players", "Svi igrači"], ["schedule", "Raspored"], ["setpieces", "Standardne situacije"], ["chips", "Čipovi"], ["import", "Uvoz CSV"], ["calibrate", "Kalibracija"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{ ...pillStyle, background: tab === key ? "#00FF87" : "#1c1233", color: tab === key ? "#0d0620" : "#cabfe9" }}>
              {label}
            </button>
          ))}
        </div>

        {tab === "recommend" && (<>
        <div style={{ display: "flex", gap: 8, margin: "14px 0", flexWrap: "wrap" }}>
          <input placeholder="Pretraži igrača (npr. Salah)" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
          {["ALL", "GK", "DEF", "MID", "FWD"].map((p) => (
            <button key={p} onClick={() => setPosFilter(p)} style={{ ...pillStyle, background: posFilter === p ? "#B983FF" : "#1c1233", color: posFilter === p ? "#0d0620" : "#cabfe9" }}>
              {p === "ALL" ? "Sve" : p}
            </button>
          ))}
        </div>

        <p style={{ color: "#8a80ab", fontSize: 12.5, marginBottom: 14 }}>
          Klikni ikonicu da ciklaš: ☆ ništa → ★ u mom timu → 👁 pratim (čuva se u tvom browseru).
        </p>

        <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden", marginBottom: 20, maxHeight: 420, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "0.4fr 1.3fr 0.5fr 0.6fr 0.6fr 0.6fr 0.6fr 1.5fr", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase", position: "sticky", top: 0 }}>
            <span></span><span>Igrač</span><span>Poz</span><span>Cena</span><span>Forma</span><span>FDR</span><span>Skor</span><span>Vest</span>
          </div>
          {filtered.slice(0, 100).map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "0.4fr 1.3fr 0.5fr 0.6fr 0.6fr 0.6fr 0.6fr 1.5fr", padding: "8px 14px", borderTop: "1px solid #2a1d4a", alignItems: "center", fontSize: 13 }}>
              <button onClick={() => cycleStatus(p.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: p.owned ? "#F2C230" : p.watch ? "#00d4ff" : "#4a3f6b" }}>
                {p.owned ? "★" : p.watch ? "👁" : "☆"}
              </button>
              <span style={{ fontWeight: 700 }}>{p.webName} <span style={{ color: "#8a80ab", fontSize: 11 }}>{p.team}</span></span>
              <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
              <span>£{p.price.toFixed(1)}m</span>
              <span>{p.form.toFixed(1)}</span>
              <span>{p.fdr}</span>
              <span style={{ fontWeight: 800, color: "#00FF87" }}>{Math.round(p.score)}</span>
              <span style={{ fontSize: 11, color: "#F2C230" }}>{newsMap[p.id] || ""}</span>
            </div>
          ))}
          {loading && <div style={{ padding: 20, textAlign: "center", color: "#8a80ab" }}>Učitavam podatke sa FPL sajta...</div>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
          <div style={{ background: "#160c2b", borderRadius: 14, padding: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#00FF87" }}>▲ Preporuka za kupovinu</h3>
            {buyCandidates.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid #2a1d4a" }}>
                <span>{p.webName} <span style={{ color: "#8a80ab", fontSize: 11 }}>{p.pos} · {p.team}</span></span>
                <b style={{ color: "#00FF87" }}>{Math.round(p.score)}</b>
              </div>
            ))}
          </div>
          <div style={{ background: "#160c2b", borderRadius: 14, padding: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#E90052" }}>▼ Razmisli o prodaji</h3>
            {sellCandidates.length === 0 && <p style={{ color: "#8a80ab", fontSize: 13 }}>Označi (★) svoje igrače gore.</p>}
            {sellCandidates.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid #2a1d4a" }}>
                <span>{p.webName} <span style={{ color: "#8a80ab", fontSize: 11 }}>{p.pos} · {p.team}</span></span>
                <b style={{ color: "#E90052" }}>{Math.round(p.score)}</b>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: "#b6aed6" }}>Kolo (GW):</span>
          <input value={gwInput} onChange={(e) => setGwInput(e.target.value)} style={{ ...inputStyle, width: 50 }} />
          <button onClick={saveSnapshot} style={{ ...btnStyle, background: "#B983FF" }}>
            📌 Sačuvaj predikciju za kalibraciju
          </button>
        </div>

        <button onClick={explainAI} disabled={aiLoading} style={{ ...btnStyle, marginBottom: 12 }}>
          {aiLoading ? "AI analizira..." : "✨ Objasni predloge (AI)"}
        </button>
        {aiText && <div style={{ background: "#160c2b", borderRadius: 14, padding: 16, whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6 }}>{aiText}</div>}
        </>)}

        {tab === "myteam" && (() => {
          const { starting, bench } = computeFormation(myTeam, overrides);
          const rows = [
            ["FWD", starting.filter((p) => p.pos === "FWD")],
            ["MID", starting.filter((p) => p.pos === "MID")],
            ["DEF", starting.filter((p) => p.pos === "DEF")],
            ["GK", starting.filter((p) => p.pos === "GK")],
          ];
          const Jersey = ({ color, score, size = 64 }) => (
            <svg width={size} height={size * 0.86} viewBox="0 0 100 100" style={{ filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.45))" }}>
              <path
                d="M28.4 6 L6.8 20 L20 37 L30.8 29 L30.8 94 L69.2 94 L69.2 29 L80 37 L93.2 20 L71.6 6 L59.6 15 Q50 21 40.4 15 Z"
                fill={color} stroke="rgba(13,6,32,0.55)" strokeWidth="3" strokeLinejoin="round"
              />
              <text x="50" y="68" textAnchor="middle" fontSize="38" fontWeight="900" fill="#0d0620" stroke="#ffffff" strokeWidth="4" paintOrder="stroke">{score}</text>
            </svg>
          );
          const Chip = ({ p, dim }) => {
            const hist = teamHistory[p.id] || [];
            const lastGw = hist.length ? hist[hist.length - 1] : null;
            return (
              <button
                onClick={() => toggleStarting(p.id, starting.includes(p))}
                title="Klikni da prebaciš između postave i klupe"
                style={{
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                  background: "none", border: "none", cursor: "pointer", width: 96, opacity: dim ? 0.7 : 1,
                }}
              >
                <Jersey color={POS_COLOR[p.pos]} score={Math.round(p.score)} />
                <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", textAlign: "center", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
                  {p.webName}
                </span>
                {lastGw && <span style={{ fontSize: 10, color: "#e5defa", background: "rgba(0,0,0,0.4)", borderRadius: 6, padding: "1px 5px" }}>GW{lastGw.gw}: {lastGw.points}</span>}
                {(p.newsNote || newsMap[p.id]) && <span style={{ fontSize: 12 }}>📰</span>}
              </button>
            );
          };
          const attackers = myTeam.filter((p) => (p.pos === "MID" || p.pos === "FWD") && p.startProb >= 85);
          const captainPick =
            attackers.sort((a, b) => b.captainScore - a.captainScore)[0] ||
            myTeam.filter((p) => p.pos === "MID" || p.pos === "FWD").sort((a, b) => b.captainScore - a.captainScore)[0] ||
            myTeam.sort((a, b) => b.captainScore - a.captainScore)[0];
          const startingWithHist = starting.map((p) => ({ p, last: (teamHistory[p.id] || [])[(teamHistory[p.id] || []).length - 1] }));
          const latestGw = startingWithHist.reduce((max, x) => (x.last && x.last.gw > max ? x.last.gw : max), 0);
          const gwTotal = startingWithHist.reduce((sum, x) => sum + (x.last && x.last.gw === latestGw ? x.last.points : 0), 0);
          const hasAnyHistory = startingWithHist.some((x) => x.last);
          return (
            <div style={{ marginTop: 14 }}>
              {myTeam.length === 0 ? (
                <p style={{ color: "#8a80ab", fontSize: 13 }}>Nemaš označenih igrača. Idi na "Preporuke" i klikni ☆ dok ne postane ★.</p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                    {captainPick && (
                      <div style={{ background: "linear-gradient(90deg, #F2C230, #ffdb6b)", borderRadius: 12, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                        <span style={{ fontSize: 20 }}>©</span>
                        <span style={{ color: "#0d0620", fontWeight: 800, fontSize: 13.5 }}>
                          Predloženi kapiten: {captainPick.webName} — kapitenski skor {Math.round(captainPick.captainScore)}, start {captainPick.startProb}%
                        </span>
                      </div>
                    )}
                    {hasAnyHistory && (
                      <div style={{ background: "#160c2b", border: "1px solid #00FF87", borderRadius: 12, padding: "10px 18px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: "#8a80ab" }}>GW{latestGw} poena (postava):</span>
                        <span style={{ fontSize: 20, fontWeight: 900, color: "#00FF87" }}>{gwTotal}</span>
                      </div>
                    )}
                  </div>
                  <p style={{ color: "#8a80ab", fontSize: 12, marginTop: 0 }}>Klikni igrača da ga prebaciš između postave i klupe. Raspored (4-4-2) se predlaže sam po skoru.</p>
                  <div style={{
                    background: "repeating-linear-gradient(180deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 34px, transparent 34px, transparent 68px), linear-gradient(180deg, #1fa563 0%, #158049 45%, #1c9a5c 100%)",
                    borderRadius: 16, padding: "12px 10px", position: "relative", overflow: "hidden",
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}>
                    <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: "70%", height: 2, background: "rgba(255,255,255,0.3)" }} />
                    <div style={{ position: "absolute", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "70%", height: 2, background: "rgba(255,255,255,0.3)" }} />
                    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 80, height: 80, border: "2px solid rgba(255,255,255,0.3)", borderRadius: "50%" }} />
                    {rows.map(([label, players]) => (
                      <div key={label} style={{ display: "flex", justifyContent: "center", gap: 4, flexWrap: "wrap", marginBottom: 8, position: "relative", zIndex: 1 }}>
                        {players.length === 0 && <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>— nema {label} u postavi —</span>}
                        {players.map((p) => <Chip key={p.id} p={p} />)}
                      </div>
                    ))}
                  </div>

                  <div style={{ background: "#160c2b", borderRadius: 14, padding: 14, marginTop: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#b6aed6", marginBottom: 10, textTransform: "uppercase" }}>Klupa</div>
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                      {bench.length === 0 && <span style={{ color: "#8a80ab", fontSize: 12 }}>Prazna klupa.</span>}
                      {bench.map((p) => <Chip key={p.id} p={p} dim />)}
                    </div>
                  </div>

                  {historyLoading && <p style={{ color: "#8a80ab", fontSize: 12, marginTop: 10 }}>Učitavam stvarne rezultate po kolima...</p>}
                  <button onClick={() => loadTeamHistory(myTeam)} disabled={historyLoading} style={{ ...btnStyle, marginTop: 12 }}>
                    🔄 Osveži stvarne rezultate
                  </button>
                </>
              )}
            </div>
          );
        })()}

        {tab === "watchlist" && (() => {
          const posFiltered = watchPosTab === "ALL" ? watchlist : watchlist.filter((p) => p.pos === watchPosTab);
          return (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
                {["ALL", "GK", "DEF", "MID", "FWD"].map((p) => (
                  <button key={p} onClick={() => setWatchPosTab(p)} style={{ ...pillStyle, background: watchPosTab === p ? "#00d4ff" : "#1c1233", color: watchPosTab === p ? "#0d0620" : "#cabfe9" }}>
                    {p === "ALL" ? "Sve" : p}
                  </button>
                ))}
              </div>
              {historyLoading && <p style={{ color: "#8a80ab", fontSize: 13 }}>Učitavam stvarne rezultate po kolima...</p>}
              {watchlist.length === 0 && <p style={{ color: "#8a80ab", fontSize: 13 }}>Nemaš igrača na listi za praćenje. Klikni ☆ dva puta (do 👁) na "Preporuke" tabu.</p>}
              {posFiltered.map((p) => {
                const hist = teamHistory[p.id] || [];
                const totalReal = hist.reduce((s, h) => s + h.points, 0);
                return (
                  <div key={p.id} style={{ background: "#160c2b", borderRadius: 14, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>{p.webName}</span>{" "}
                        <span style={{ color: POS_COLOR[p.pos], fontSize: 11 }}>{p.pos}</span>{" "}
                        <span style={{ color: "#8a80ab", fontSize: 11 }}>{p.team} · £{p.price.toFixed(1)}m</span>
                      </div>
                      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "#8a80ab" }}>Skor: <b style={{ color: "#00FF87" }}>{Math.round(p.score)}</b></span>
                        {hist.length > 0 && <span style={{ fontSize: 12, color: "#8a80ab" }}>Ukupno: <b>{totalReal} pt</b></span>}
                      </div>
                    </div>
                    {hist.length > 0 ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        {hist.map((h) => (
                          <div key={h.gw} style={{ background: "#0d0620", borderRadius: 8, padding: "4px 8px", fontSize: 11.5 }}>
                            GW{h.gw}: <b style={{ color: h.points >= 6 ? "#00FF87" : h.points >= 2 ? "#e5defa" : "#ff8a8a" }}>{h.points}</b>
                          </div>
                        ))}
                      </div>
                    ) : (
                      !historyLoading && <p style={{ fontSize: 11.5, color: "#8a80ab", marginTop: 6, marginBottom: 0 }}>Još nema odigranih kola za ovog igrača.</p>
                    )}
                    {p.newsNote && <p style={{ fontSize: 11.5, color: "#F2C230", marginTop: 6, marginBottom: 0 }}>📰 {p.newsNote}</p>}
                    {newsMap[p.id] && <p style={{ fontSize: 11.5, color: "#F2C230", marginTop: 6, marginBottom: 0 }}>📰 {newsMap[p.id]}</p>}
                  </div>
                );
              })}
              {watchlist.length > 0 && (
                <button onClick={() => loadTeamHistory(watchlist)} disabled={historyLoading} style={{ ...btnStyle, marginTop: 4 }}>
                  🔄 Osveži stvarne rezultate
                </button>
              )}
            </div>
          );
        })()}

        {tab === "players" && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#b6aed6", fontSize: 12.5, marginTop: 0 }}>
              Ovde možeš ručno prepisati Start% i vesti za bilo kog igrača (npr. ako imaš svežiju informaciju od API-ja),
              ili dodati potpuno novog igrača koji još nije u FPL bazi.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <button onClick={cleanupDuplicates} style={{ ...btnStyle, background: "#B983FF" }}>🧹 Ukloni duplikate</button>
              {csvInfo && <span style={{ color: "#00FF87", fontSize: 12.5 }}>{csvInfo}</span>}
            </div>

            <div style={{ background: "#160c2b", borderRadius: 14, padding: 14, marginBottom: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.6fr 0.6fr 0.6fr 0.6fr auto", gap: 8, marginBottom: 8 }}>
                <input placeholder="Ime" value={manualForm.name} onChange={(e) => setManualForm({ ...manualForm, name: e.target.value })} style={inputStyle} />
                <select value={manualForm.pos} onChange={(e) => setManualForm({ ...manualForm, pos: e.target.value })} style={inputStyle}>
                  {["GK", "DEF", "MID", "FWD"].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input placeholder="Klub" value={manualForm.team} onChange={(e) => setManualForm({ ...manualForm, team: e.target.value })} style={inputStyle} />
                <input placeholder="Cena" value={manualForm.price} onChange={(e) => setManualForm({ ...manualForm, price: e.target.value })} style={inputStyle} />
                <input placeholder="FDR" value={manualForm.fdr} onChange={(e) => setManualForm({ ...manualForm, fdr: e.target.value })} style={inputStyle} />
                <button onClick={addManualPlayer} style={btnStyle}>+ Dodaj</button>
              </div>
              <p style={{ fontSize: 11, color: "#8a80ab", margin: "0 0 8px" }}>
                Napomena: ako dodaješ igrača koji verovatno već postoji u FPL bazi, koristi njegovo skraćeno ime
                (npr. "Thiago" umesto "Igor Thiago") da izbegneš duplikat — ili unesi bilo koje ime pa klikni "Ukloni duplikate" posle.
              </p>
            </div>

            <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden", maxHeight: 480, overflowY: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.35fr 1.1fr 0.5fr 0.6fr 0.6fr 0.6fr 1.2fr 1.4fr 0.6fr 0.6fr 0.4fr", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase", position: "sticky", top: 0 }}>
                <span></span><span>Igrač</span><span>Poz</span><span>Cena</span><span>Skor</span><span>Start%</span><span>Vesti</span><span>Beleška</span><span title="Izvodi penale/kornere">⚽ Set</span><span title="Novo pojačanje ovog leta">🆕 Nov</span><span></span>
              </div>
              {scored.slice().sort((a, b) => b.score - a.score).slice(0, 150).map((p) => (
                <div key={p.id} style={{ display: "grid", gridTemplateColumns: "0.35fr 1.1fr 0.5fr 0.6fr 0.6fr 0.6fr 1.2fr 1.4fr 0.6fr 0.6fr 0.4fr", padding: "7px 14px", borderTop: "1px solid #2a1d4a", alignItems: "center", fontSize: 12.5 }}>
                  <button onClick={() => cycleStatus(p.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: p.owned ? "#F2C230" : p.watch ? "#00d4ff" : "#4a3f6b" }}>
                    {p.owned ? "★" : p.watch ? "👁" : "☆"}
                  </button>
                  <span style={{ fontWeight: 700 }}>{p.webName} <span style={{ color: "#8a80ab", fontSize: 10.5 }}>{p.team}</span></span>
                  <span style={{ color: POS_COLOR[p.pos] }}>{p.pos}</span>
                  <span>£{p.price.toFixed(1)}m</span>
                  <span style={{ fontWeight: 800, color: "#00FF87" }}>{Math.round(p.score)}</span>
                  <input
                    type="number" min="0" max="100"
                    defaultValue={(overrides[p.id] && overrides[p.id].startProb) ?? p.startProb}
                    onBlur={(e) => setOverrideField(p.id, "startProb", e.target.value)}
                    style={{ width: 55, padding: "4px 6px", borderRadius: 6, border: "1px solid #2a1d4a", background: "#0d0620", color: "#e5defa" }}
                  />
                  <select
                    defaultValue={(overrides[p.id] && overrides[p.id].newsImpact) ?? "0"}
                    onChange={(e) => setOverrideField(p.id, "newsImpact", e.target.value)}
                    style={{ ...inputStyle, padding: "4px 6px" }}
                  >
                    {NEWS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                  </select>
                  <input
                    placeholder="npr. bol u preponi..."
                    defaultValue={(overrides[p.id] && overrides[p.id].newsNote) || ""}
                    onBlur={(e) => setOverrideField(p.id, "newsNote", e.target.value)}
                    style={{ ...inputStyle, padding: "4px 6px" }}
                  />
                  <input
                    type="checkbox" title="Izvodi penale/kornere (+6 skor)"
                    defaultChecked={!!(overrides[p.id] && overrides[p.id].setPiece)}
                    onChange={(e) => setOverrideField(p.id, "setPiece", e.target.checked)}
                  />
                  <input
                    type="checkbox" title="Novo pojačanje ovog leta (kazna dok ne potvrdi mesto)"
                    defaultChecked={!!(overrides[p.id] && overrides[p.id].newSigning)}
                    onChange={(e) => setOverrideField(p.id, "newSigning", e.target.checked)}
                  />
                  {String(p.id).startsWith("manual-")
                    ? <button onClick={() => removeManualPlayer(p.id)} style={{ background: "none", border: "none", color: "#8a80ab", cursor: "pointer" }}>✕</button>
                    : <span />}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "schedule" && (() => {
          const FDR_COLOR = { 1: "#0ba85a", 2: "#7ddc9d", 3: "#5b5470", 4: "#e08a3c", 5: "#e0405a" };
          const teams = Object.entries(fixtureTicker).sort((a, b) => a[0].localeCompare(b[0]));
          return (
            <div style={{ marginTop: 14 }}>
              <p style={{ color: "#8a80ab", fontSize: 12.5, marginTop: 0 }}>
                Sledećih 6 kola po timu. Boja = težina (zeleno = lako, crveno = teško) — isti princip kao na zvaničnom FPL sajtu.
              </p>
              {teams.length === 0 && <p style={{ color: "#8a80ab", fontSize: 13 }}>Nema podataka — klikni "Osveži podatke".</p>}
              <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "0.8fr repeat(6, 1fr)", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase" }}>
                  <span>Tim</span>
                  {[1, 2, 3, 4, 5, 6].map((n) => <span key={n} style={{ textAlign: "center" }}>K{n}</span>)}
                </div>
                {teams.map(([teamName, fixtures]) => (
                  <div key={teamName} style={{ display: "grid", gridTemplateColumns: "0.8fr repeat(6, 1fr)", padding: "6px 14px", borderTop: "1px solid #2a1d4a", alignItems: "center" }}>
                    <span style={{ fontWeight: 700, fontSize: 12.5 }}>{teamName}</span>
                    {Array.from({ length: 6 }).map((_, i) => {
                      const f = fixtures[i];
                      return (
                        <div key={i} style={{ textAlign: "center" }}>
                          {f ? (
                            <span style={{
                              display: "inline-block", width: "90%", padding: "3px 0", borderRadius: 6,
                              background: FDR_COLOR[f.fdr] || "#5b5470", color: "#fff", fontSize: 11, fontWeight: 700,
                            }}>
                              {f.opponent}{f.isHome ? "(D)" : "(G)"}
                            </span>
                          ) : <span style={{ color: "#4a3f6b", fontSize: 11 }}>—</span>}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {tab === "setpieces" && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#8a80ab", fontSize: 12.5, marginTop: 0 }}>
              Zvanične FPL napomene o izvođačima penala/kornera/slobodnjaka po timu — ništa ne unosiš ručno,
              povlači se automatski. Napomene su na engleskom (izvor je zvanični FPL sajt); ako želiš, koristi
              ove informacije da čekiraš "⚽ Set" na igraču u "Svi igrači" tabu.
            </p>
            {setPieceNotes.length === 0 && (
              <p style={{ color: "#8a80ab", fontSize: 13 }}>
                Trenutno nema dostupnih napomena (FPL ih objavljuje postepeno, obično bliže početku sezone/kola) —
                probaj "🔄 Osveži podatke" ponovo kasnije.
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {setPieceNotes.map((t, i) => (
                <div key={i} style={{ background: "#160c2b", borderRadius: 12, padding: "12px 16px" }}>
                  <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 4, color: "#00FF87" }}>{t.team}</div>
                  <div style={{ fontSize: 12.5, color: "#e5defa", lineHeight: 1.5 }}>{t.notes}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "chips" && (() => {
          const CHIP_ROWS = [
            ["wildcard1", "Wildcard #1", "Fleksibilno — mnogi ga čekaju do GW4 (kad se prelazni rok zatvori) ili GW6 (posle pauze za reprezentacije)."],
            ["wildcard2", "Wildcard #2", "Obično se čuva za drugi deo sezone, npr. oko GW20+, ili reaktivno kod povreda/naglih promena rasporeda."],
            ["freehit1", "Free Hit #1", "GW3 se izdvaja — nekoliko velikih direktnih duela u istom kolu, pa Free Hit izbegava dupli rizik na oba tima."],
            ["freehit2", "Free Hit #2", "Dobra opcija za kolo sa dosta blank/double gameweek-ova kasnije u sezoni, ili nepredviđene krize kod tvog tima."],
            ["benchboost1", "Bench Boost #1", "GW1 ako gradiš jak tim od 15 od starta, ili GW2 zbog nesigurnih ranih sastava. Radi najbolje odmah posle Wildcard-a."],
            ["benchboost2", "Bench Boost #2", "Isto pravilo — najbolje odmah nakon drugog Wildcard-a, kad je cela klupa sveže popunjena kvalitetnim igračima."],
            ["triplecaptain1", "Triple Captain #1", "GW3 je prvi izbor većine (Haaland dočekuje Coventry); alternativa GW7 posle pauze za reprezentacije."],
            ["triplecaptain2", "Triple Captain #2", "Čuva se za kolo sa najlakšim mogućim rasporedom tvog kapitena kasnije u sezoni — prati raspored kad se približi."],
          ];
          return (
            <div style={{ marginTop: 14 }}>
              <p style={{ color: "#8a80ab", fontSize: 12.5, marginTop: 0 }}>
                Planiraj unapred kad ćeš iskoristiti čipove — po pravilu "planiraj, ne paniči posle lošeg kola". Predlozi ispod su opšte smernice, ne garancija.
              </p>
              <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.6fr", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase" }}>
                  <span>Čip</span><span>Planirano kolo</span><span>Iskorišćen</span>
                </div>
                {CHIP_ROWS.map(([key, label, hint]) => {
                  const c = chips[key] || { gw: "", used: false };
                  return (
                  <div key={key} style={{ padding: "9px 14px", borderTop: "1px solid #2a1d4a" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr 0.6fr", alignItems: "center", fontSize: 13 }}>
                      <span style={{ fontWeight: 700 }}>{label}</span>
                      <input
                        placeholder="npr. GW8" value={c.gw}
                        onChange={(e) => setChips((prev) => ({ ...prev, [key]: { ...c, gw: e.target.value } }))}
                        style={{ ...inputStyle, width: 90 }}
                      />
                      <input
                        type="checkbox" checked={c.used}
                        onChange={(e) => setChips((prev) => ({ ...prev, [key]: { ...c, used: e.target.checked } }))}
                      />
                    </div>
                    <p style={{ fontSize: 11, color: "#8a80ab", margin: "6px 0 0" }}>{hint}</p>
                  </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {tab === "import" && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#b6aed6", fontSize: 12.5, marginTop: 0 }}>
              Nalepi CSV (prvi red = zaglavlje): <code style={{ color: "#00FF87" }}>name,pos,team,price,ownership,form,total,fdr,startProb,newsImpact,newsNote,owned</code><br />
              Ako se ime poklopi sa postojećim igračem, ažuriraju se Start%/vesti/tim. Ako ne postoji, dodaje se kao nov igrač.
            </p>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={"name,pos,team,price,ownership,form,total,fdr,startProb,newsImpact,newsNote,owned\nSalah,MID,LIV,13.5,45,8.2,28,3,95,0,,false"}
              style={{ width: "100%", minHeight: 160, background: "#160c2b", color: "#e5defa", border: "1px solid #2a1d4a", borderRadius: 10, padding: 12, fontSize: 12.5, fontFamily: "monospace", resize: "vertical" }}
            />
            {csvError && <p style={{ color: "#ff8a8a", fontSize: 13 }}>{csvError}</p>}
            {csvInfo && <p style={{ color: "#00FF87", fontSize: 13 }}>{csvInfo}</p>}
            <button onClick={parseCsv} style={{ ...btnStyle, marginTop: 10 }}>⬆ Uvezi podatke</button>
          </div>
        )}

        {tab === "calibrate" && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#b6aed6", fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>
              Kad sačuvaš predikciju na tabu Preporuke, ona se ovde zapiše sa skorom u tom trenutku.
              Kad prođe kolo, klikni dugme ispod da se stvarni poeni povuku automatski sa FPL sajta —
              ručno unosi samo ako alat ne uspe da pronađe podatak (npr. vrlo star unos).
            </p>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
              <button onClick={autoFillActuals} disabled={historyLoading} style={btnStyle}>
                {historyLoading ? "Povlačim..." : "⚡ Povuci stvarne poene automatski"}
              </button>
              {csvInfo && <span style={{ color: "#00FF87", fontSize: 12.5 }}>{csvInfo}</span>}
            </div>

            {calibStats && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}>
                <div style={statCard}><div style={statLabel}>Prosek "kupi"</div><div style={statValue}>{calibStats.buyAvg?.toFixed(1) ?? "—"} pt</div></div>
                <div style={statCard}><div style={statLabel}>Prosek "prodaj"</div><div style={statValue}>{calibStats.sellAvg?.toFixed(1) ?? "—"} pt</div></div>
                <div style={statCard}><div style={statLabel}>Korelacija skor↔poeni</div><div style={statValue}>{calibStats.corr.toFixed(2)}</div></div>
              </div>
            )}

            {featureCorrelations && (
              <div style={{ background: "#160c2b", borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Koji faktor zaista prati stvarne poene?</div>
                {featureCorrelations.map((f) => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 140, fontSize: 12.5, color: "#b6aed6" }}>{f.label}</span>
                    <div style={{ flex: 1, height: 8, background: "#0d0620", borderRadius: 999, position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", top: 0, bottom: 0, left: f.corr >= 0 ? "50%" : `${50 + f.corr * 50}%`, width: `${Math.abs(f.corr) * 50}%`, background: f.corr >= 0 ? "#00FF87" : "#E90052" }} />
                    </div>
                    <span style={{ width: 36, fontSize: 12, textAlign: "right" }}>{f.corr.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <button onClick={runAutoCalibrate} disabled={withActual.length < 6} style={{ ...btnStyle, opacity: withActual.length < 6 ? 0.5 : 1 }}>
                Predloži nove težine ({withActual.length}/6)
              </button>
              {suggestedWeights && <button onClick={applySuggestedWeights} style={{ ...btnStyle, background: "#B983FF" }}>Primeni</button>}
            </div>

            {suggestedWeights && (
              <div style={{ background: "#160c2b", borderRadius: 14, padding: 16, marginBottom: 16, fontSize: 13.5 }}>
                <div style={{ color: "#00FF87", fontWeight: 700, marginBottom: 6 }}>Predložene težine (trenutne u zagradi):</div>
                <div>Forma: {(suggestedWeights.form * 100).toFixed(0)}% ({(weights.form * 100).toFixed(0)}%)</div>
                <div>Vrednost: {(suggestedWeights.value * 100).toFixed(0)}% ({(weights.value * 100).toFixed(0)}%)</div>
                <div>Raspored: {(suggestedWeights.fixture * 100).toFixed(0)}% ({(weights.fixture * 100).toFixed(0)}%)</div>
                <div>Start%: {(suggestedWeights.start * 100).toFixed(0)}% ({(weights.start * 100).toFixed(0)}%)</div>
                <div>Vesti: {(suggestedWeights.news * 100).toFixed(0)}% ({(weights.news * 100).toFixed(0)}%)</div>
              </div>
            )}

            <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "0.5fr 1.2fr 0.6fr 0.6fr 0.7fr 0.8fr 0.4fr", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase" }}>
                <span>GW</span><span>Igrač</span><span>Poz</span><span>Tip</span><span>Skor</span><span>Poeni</span><span></span>
              </div>
              {history.length === 0 && <div style={{ padding: 20, textAlign: "center", color: "#8a80ab", fontSize: 13 }}>Nema sačuvanih predikcija.</div>}
              {history.slice().reverse().map((h) => (
                <div key={h.hid} style={{ display: "grid", gridTemplateColumns: "0.5fr 1.2fr 0.6fr 0.6fr 0.7fr 0.8fr 0.4fr", padding: "8px 14px", borderTop: "1px solid #2a1d4a", alignItems: "center", fontSize: 13 }}>
                  <span>{h.gw}</span>
                  <span style={{ fontWeight: 700 }}>{h.name}</span>
                  <span style={{ color: POS_COLOR[h.pos] }}>{h.pos}</span>
                  <span style={{ color: h.type === "buy" ? "#00FF87" : "#E90052", fontWeight: 700, fontSize: 12 }}>{h.type === "buy" ? "Kupi" : "Prodaj"}</span>
                  <span>{Math.round(h.score)}</span>
                  <input type="number" defaultValue={h.actual ?? ""} placeholder="poeni" onBlur={(e) => setActual(h.hid, e.target.value)} style={{ width: 70, padding: "5px 8px", borderRadius: 8, border: "1px solid #2a1d4a", background: "#0d0620", color: "#e5defa" }} />
                  <button onClick={() => removeHistoryEntry(h.hid)} style={{ background: "none", border: "none", color: "#8a80ab", cursor: "pointer" }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const statCard = { background: "#160c2b", borderRadius: 12, padding: "12px 14px" };
const statLabel = { fontSize: 11.5, color: "#8a80ab", marginBottom: 4, textTransform: "uppercase" };
const statValue = { fontSize: 20, fontWeight: 800 };

const inputStyle = { padding: "9px 10px", borderRadius: 8, border: "1px solid #2a1d4a", background: "#160c2b", color: "#e5defa", fontSize: 13, outline: "none" };
const pillStyle = { border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const btnStyle = { background: "#00FF87", color: "#0d0620", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer" };