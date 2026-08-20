# FPL Transfer Savetnik

Automatski povlači prave podatke sa zvaničnog Fantasy Premier League sajta
(cene, formu, raspored, povrede) i prevodi/sažima vesti o povredama na
srpski preko Claude (Anthropic) API-ja.

## Kako radi (ukratko)

- `pages/api/fpl-data.js` — server (ne browser!) povlači podatke sa
  `fantasy.premierleague.com`. Zato CORS ovde nije problem.
- `pages/api/news.js` — šalje engleski FPL "news" tekst Claude-u i vraća
  kratak srpski sažetak po igraču.
- `pages/api/explain.js` — na zahtev, Claude objašnjava zašto su baš ti
  igrači predloženi za kupovinu/prodaju.
- `pages/index.js` — stranica koju vidiš u browseru; ona samo poziva tvoje
  sopstvene `/api/...` rute, nikad direktno FPL ili Anthropic.

## Postavljanje na Vercel (korak po korak)

1. **Napravi nalog na [github.com](https://github.com)** ako ga nemaš, i
   napravi novi, prazan repozitorijum (npr. `fpl-advisor`).
2. U terminalu, u ovom folderu:
   ```bash
   git init
   git add .
   git commit -m "prva verzija"
   git branch -M main
   git remote add origin https://github.com/TVOJ-NALOG/fpl-advisor.git
   git push -u origin main
   ```
3. Idi na **[vercel.com](https://vercel.com)**, uloguj se preko GitHub-a,
   klikni **"Add New Project"** i izaberi repozitorijum koji si upravo
   napravio. Vercel sam prepoznaje da je Next.js projekat — ne menjaj
   ništa, samo klikni **Deploy**.
4. Prvi deploy će "raditi" ali AI delovi neće — nedostaje ključ. Idi u
   **Project Settings → Environment Variables** i dodaj:
   - Key: `ANTHROPIC_API_KEY`
   - Value: tvoj ključ sa [console.anthropic.com](https://console.anthropic.com)
     (Settings → API Keys → Create Key)
5. Klikni **Redeploy** (u Deployments tabu) da se ključ primeni.
6. Gotovo — dobijaš adresu tipa `fpl-advisor-tvojnalog.vercel.app`.

## Lokalno testiranje (opciono, pre nego što deploy-uješ)

```bash
npm install
cp .env.example .env.local   # pa upiši svoj pravi ključ u .env.local
npm run dev
```
Otvori `http://localhost:3000`.

## Šta dalje možemo dograditi

- Bazu (Vercel Postgres/KV) da se podaci čuvaju i ne pozivaju Claude
  iznova pri svakoj poseti (jeftinije i brže).
- Automatsko osvežavanje pred svako kolo (Vercel Cron Jobs).
- Kalibraciju predikcija (istorija predloga vs. stvarni rezultati) — ovo
  je bilo u prethodnoj artefakt verziji, može se preneti ovde uz malu bazu.
