// Ova funkcija se izvršava NA SERVERU (ne u browseru tvog posetioca),
// pa CORS ograničenje zvaničnog FPL sajta ovde ne važi.

const POS_BY_ELEMENT_TYPE = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

function nextFixtureDifficulty(fixtures, teamId) {
  const upcoming = fixtures
    .filter((f) => !f.finished && (f.team_h === teamId || f.team_a === teamId))
    .sort((a, b) => (a.event || 999) - (b.event || 999));
  if (!upcoming.length) return { fdr: 3, opponent: null, isHome: null };
  const f = upcoming[0];
  const isHome = f.team_h === teamId;
  return { fdr: isHome ? f.team_h_difficulty : f.team_a_difficulty, opponent: isHome ? f.team_a : f.team_h, isHome };
}

function startProbFromStatus(status, chance) {
  if (chance !== null && chance !== undefined) return chance;
  if (status === "a") return 95;
  if (status === "d") return 50;
  if (status === "i" || status === "s" || status === "u") return 5;
  return 90;
}

export default async function handler(req, res) {
  try {
    const [bootstrapRes, fixturesRes] = await Promise.all([
      fetch("https://fantasy.premierleague.com/api/bootstrap-static/"),
      fetch("https://fantasy.premierleague.com/api/fixtures/"),
    ]);

    if (!bootstrapRes.ok || !fixturesRes.ok) {
      throw new Error(`FPL API vratio grešku: ${bootstrapRes.status} / ${fixturesRes.status}`);
    }

    const bootstrap = await bootstrapRes.json();
    const fixtures = await fixturesRes.json();

    const teamsById = Object.fromEntries(bootstrap.teams.map((t) => [t.id, t.short_name]));

    const players = bootstrap.elements.map((e) => {
      const { fdr, opponent, isHome } = nextFixtureDifficulty(fixtures, e.team);
      return {
        id: e.id,
        name: `${e.first_name} ${e.second_name}`.trim(),
        webName: e.web_name,
        pos: POS_BY_ELEMENT_TYPE[e.element_type] || "MID",
        team: teamsById[e.team] || "—",
        opponent: opponent ? teamsById[opponent] : null,
        isHome,
        price: e.now_cost / 10,
        ownership: parseFloat(e.selected_by_percent) || 0,
        form: parseFloat(e.form) || 0,
        total: e.total_points || 0,
        fdr,
        status: e.status, // a=spreman, d=upitan, i=povređen, s=suspendovan, u=nedostupan
        rawNews: e.news || "", // zvaničan tekst sa FPL sajta, obično na engleskom
        startProb: startProbFromStatus(e.status, e.chance_of_playing_next_round),
      };
    });

    res.status(200).json({ players, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Neuspešno povlačenje FPL podataka", details: String(err) });
  }
}
