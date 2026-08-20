import { useEffect, useMemo, useState } from "react";

const POS_COLOR = { GK: "#F2C230", DEF: "#00FF87", MID: "#B983FF", FWD: "#E90052" };
const DEFAULT_WEIGHTS = { form: 0.25, value: 0.15, fixture: 0.15, start: 0.2, news: 0.15 };
const LS_KEY = "fpl_advisor_state_v1";

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
  const forms = players.map((p) => p.form);
  const values = players.map((p) => (p.price > 0 ? p.total / p.price : 0));
  const fdrs = players.map((p) => p.fdr);
  const fMin = Math.min(...forms), fMax = Math.max(...forms);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const dMin = Math.min(...fdrs), dMax = Math.max(...fdrs);

  return players.map((p) => {
    const value = p.price > 0 ? p.total / p.price : 0;
    const formScore = norm(p.form, fMin, fMax);
    const valueScore = norm(value, vMin, vMax);
    const fixtureScore = norm(p.fdr, dMin, dMax, true);
    const startScore = Math.max(0, Math.min(100, p.startProb));
    const impact = newsImpactFromPlayer(p);
    const newsScore = Math.max(0, Math.min(100, 50 + impact * 15));
    const differentialBonus = p.ownership < 10 ? 4 : 0;
    const raw =
      formScore * weights.form + valueScore * weights.value + fixtureScore * weights.fixture +
      startScore * weights.start + newsScore * weights.news + differentialBonus;
    const owned = !!(overrides[p.id] && overrides[p.id].owned);
    return { ...p, value, formScore, valueScore, fixtureScore, startScore, newsScore, owned, score: Math.max(0, Math.min(100, raw)) };
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
  const [tab, setTab] = useState("recommend");
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [history, setHistory] = useState([]);
  const [gwInput, setGwInput] = useState("1");
  const [suggestedWeights, setSuggestedWeights] = useState(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (saved.overrides) setOverrides(saved.overrides);
      if (saved.history) setHistory(saved.history);
      if (saved.weights) setWeights(saved.weights);
    } catch {}
    loadData();
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ overrides, history, weights }));
  }, [overrides, history, weights]);

  async function loadData() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/fpl-data");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRawPlayers(data.players);
      setFetchedAt(data.fetchedAt);

      const withNews = data.players.filter((p) => p.rawNews);
      if (withNews.length) {
        const newsRes = await fetch("/api/news", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ players: withNews }),
        });
        const newsData = await newsRes.json();
        const map = {};
        (newsData.translated || []).forEach((n) => { map[n.id] = n.summary; });
        setNewsMap(map);
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  const scored = useMemo(() => computeScores(rawPlayers, weights, overrides), [rawPlayers, weights, overrides]);

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

  function toggleOwned(id) {
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], owned: !(prev[id] && prev[id].owned) } }));
  }

  function saveSnapshot() {
    const gw = parseInt(gwInput) || 0;
    const logFields = (p) => ({
      formScore: p.formScore, valueScore: p.valueScore, fixtureScore: p.fixtureScore,
      startScore: p.startScore, newsScore: p.newsScore,
    });
    const buyLogs = buyCandidates.map((p) => ({
      hid: `${Date.now()}-b-${p.id}`, gw, name: p.webName, pos: p.pos, type: "buy",
      score: p.score, ...logFields(p), actual: null,
    }));
    const sellLogs = sellCandidates.map((p) => ({
      hid: `${Date.now()}-s-${p.id}`, gw, name: p.webName, pos: p.pos, type: "sell",
      score: p.score, ...logFields(p), actual: null,
    }));
    setHistory((prev) => [...prev, ...buyLogs, ...sellLogs]);
    setTab("calibrate");
  }

  function setActual(hid, val) {
    const n = parseFloat(val);
    setHistory((prev) => prev.map((h) => (h.hid === hid ? { ...h, actual: isNaN(n) ? null : n } : h)));
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
          <button onClick={loadData} disabled={loading} style={btnStyle}>
            {loading ? "Osvežavam..." : "🔄 Osveži podatke"}
          </button>
        </div>
        {fetchedAt && <p style={{ color: "#8a80ab", fontSize: 12, marginTop: 0 }}>Poslednje osveženo: {new Date(fetchedAt).toLocaleString("sr-RS")}</p>}
        {error && <p style={{ color: "#ff8a8a" }}>Greška: {error}</p>}

        <div style={{ display: "flex", gap: 6, margin: "14px 0" }}>
          {[["recommend", "Preporuke"], ["calibrate", "Kalibracija"]].map(([key, label]) => (
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
          Klikni ☆ pored igrača da ga označiš kao "u mom timu" (čuva se u tvom browseru).
        </p>

        <div style={{ background: "#160c2b", borderRadius: 14, overflow: "hidden", marginBottom: 20, maxHeight: 420, overflowY: "auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "0.4fr 1.3fr 0.5fr 0.6fr 0.6fr 0.6fr 0.6fr 1.5fr", padding: "9px 14px", background: "#1c1233", fontSize: 11, fontWeight: 700, color: "#b6aed6", textTransform: "uppercase", position: "sticky", top: 0 }}>
            <span></span><span>Igrač</span><span>Poz</span><span>Cena</span><span>Forma</span><span>FDR</span><span>Skor</span><span>Vest</span>
          </div>
          {filtered.slice(0, 100).map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "0.4fr 1.3fr 0.5fr 0.6fr 0.6fr 0.6fr 0.6fr 1.5fr", padding: "8px 14px", borderTop: "1px solid #2a1d4a", alignItems: "center", fontSize: 13 }}>
              <button onClick={() => toggleOwned(p.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: p.owned ? "#F2C230" : "#4a3f6b" }}>
                {p.owned ? "★" : "☆"}
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

        {tab === "calibrate" && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: "#b6aed6", fontSize: 13, lineHeight: 1.6, marginTop: 0 }}>
              Kad sačuvaš predikciju na tabu Preporuke, ona se ovde zapiše sa skorom u tom trenutku.
              Kad prođe kolo, upiši koliko je igrač stvarno osvojio poena — dugme dole onda predlaže nove
              težine na osnovu toga šta je zaista pratilo stvarne rezultate.
            </p>

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