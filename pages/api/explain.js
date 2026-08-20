export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Samo POST metoda." });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY nije podešen na serveru." });
  }

  const { buy, sell } = req.body || {};

  const prompt =
    "Ti si Fantasy Premier League (FPL) analitičar. Na osnovu ovih podataka o igračima (JSON ispod), " +
    "napiši KRATKO obrazloženje na srpskom jeziku za koje transfere ulazi (buy) i izlazi (sell) preporučuješ pred sledeće kolo. " +
    "Za svakog igrača iz 'buy' liste napiši jednu rečenicu zašto je dobar izbor sada, a za 'sell' listu jednu rečenicu zašto razmisliti o prodaji. " +
    "Uzmi u obzir startProb (verovatnoća starta u %) i newsSummary (povrede/najave) kao ključne faktore rizika. " +
    "Bez uvoda i zaključka, samo lista.\n\n" +
    JSON.stringify({ buy, sell });

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
        max_tokens: 1200,
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
      .join("\n");

    res.status(200).json({ text: text || "Nema odgovora." });
  } catch (err) {
    res.status(500).json({ error: "AI objašnjenje nije uspelo", details: String(err) });
  }
}
