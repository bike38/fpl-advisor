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

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (saved.overrides) setOverrides(saved.overrides);
    } catch {}
    loadData();
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify({ overrides }));
  }, [overrides]);

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

  const scored = useMemo(() => computeScores(rawPlayers, DEFAULT_WEIGHTS, overrides), [rawPlayers, overrides]);

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

        <button onClick={explainAI} disabled={aiLoading} style={{ ...btnStyle, marginBottom: 12 }}>
          {aiLoading ? "AI analizira..." : "✨ Objasni predloge (AI)"}
        </button>
        {aiText && <div style={{ background: "#160c2b", borderRadius: 14, padding: 16, whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.6 }}>{aiText}</div>}
      </div>
    </div>
  );
}

const inputStyle = { padding: "9px 10px", borderRadius: 8, border: "1px solid #2a1d4a", background: "#160c2b", color: "#e5defa", fontSize: 13, outline: "none" };
const pillStyle = { border: "none", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const btnStyle = { background: "#00FF87", color: "#0d0620", border: "none", borderRadius: 8, padding: "9px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer" };
