// Prima listu igrača sa engleskim FPL "news" tekstom i vraća kratak srpski
// sažetak za svakog. Anthropic ključ se čita iz environment varijable na
// serveru - nikad se ne šalje u browser.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Samo POST metoda." });

  const { players } = req.body || {};
  const relevant = (players || []).filter((p) => p.rawNews && p.rawNews.trim().length > 0).slice(0, 40);

  if (relevant.length === 0) {
    return res.status(200).json({ translated: [] });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY nije podešen na serveru." });
  }

  const prompt =
    "Prevedi sledeće zvanične FPL vesti o fudbalerima na srpski jezik. Za svakog igrača napiši JEDNU kratku " +
    "rečenicu, samo najbitnije (povreda, sumnja, povratak, suspenzija). Vrati ISKLJUČIVO validan JSON niz, " +
    'bez ikakvog uvoda ili markdown ograde, u formatu: [{"id": 123, "summary": "..."}]\n\n' +
    JSON.stringify(relevant.map((p) => ({ id: p.id, name: p.webName || p.name, news: p.rawNews })));

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Anthropic API greška ${r.status}: ${errText}`);
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let translated = [];
    try {
      translated = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      translated = [];
    }

    res.status(200).json({ translated });
  } catch (err) {
    res.status(500).json({ error: "Prevod nije uspeo", details: String(err) });
  }
}