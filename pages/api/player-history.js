// Povlači stvarnu istoriju poena po kolima za date igrače, direktno sa FPL sajta.
// Server-side poziv (nema CORS problema), i ne koristi AI - potpuno besplatno.

export default async function handler(req, res) {
  const idsParam = req.query.ids || "";
  const ids = idsParam.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ids.length) return res.status(200).json({ results: [] });

  try {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await fetch(`https://fantasy.premierleague.com/api/element-summary/${id}/`);
          if (!r.ok) return { id, history: [] };
          const data = await r.json();
          const history = (data.history || []).map((h) => ({
            gw: h.round,
            points: h.total_points,
            minutes: h.minutes,
            opponent: h.opponent_team,
            wasHome: h.was_home,
          }));
          return { id, history };
        } catch {
          return { id, history: [] };
        }
      })
    );
    res.status(200).json({ results });
  } catch (err) {
    res.status(500).json({ error: "Neuspešno povlačenje istorije", details: String(err) });
  }
}