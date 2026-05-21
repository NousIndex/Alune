# Liner Notes

A quiet lyrics reader that sets **Hànyǔ Pīnyīn** over Chinese and **rōmaji** over
Japanese — right above the original characters — and leaves English alone. Your
library lives in the browser; nothing is sent to a server.

Built with **Vite + React**. Deploys to Vercel with zero configuration.

## How it works

| Language | Engine | Notes |
|----------|--------|-------|
| Chinese  | [`pinyin-pro`](https://github.com/zh-lx/pinyin-pro) | Per-character pinyin with tone marks, context-aware for 多音字. |
| Japanese | [`kuroshiro`](https://github.com/hexenq/kuroshiro) + kuromoji | Word-level readings; a real morphological analyzer reads kanji in context. |
| Japanese (fallback) | [`wanakana`](https://github.com/WaniKani/WanaKana) | If the dictionary can't load, kana is still romanized with no dictionary. |

The kuromoji dictionary (~12 MB) is **self-hosted** at `/dict/`. The script
`scripts/copy-dict.mjs` copies it out of the npm package into `public/dict` on
`postinstall`, `predev`, and `prebuild`, so it ships from your own domain.

## Run locally

```bash
npm install        # also copies the dictionary into public/dict
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # output in dist/
npm run preview    # serve the production build locally
```

## Deploy to Vercel

1. Push this folder to a GitHub/GitLab repo.
2. In Vercel, **New Project → Import** the repo.
3. Framework preset is detected as **Vite**. Defaults are correct:
   - Build command: `npm run build`
   - Output directory: `dist`
4. Deploy. Over HTTPS the dictionary loads cleanly, so you get full kanji
   readings.

> No environment variables or server functions are needed — this is a fully
> static client-side app.

## Notes

- The app seeds three **public-domain** samples (a Li Bai poem, two Bashō haiku,
  an English note). Delete them once you've added your own lyrics with **+**.
- The particle は is romanized *wa* and へ as *e* in full-engine mode, as expected.
- **Export / Import** (bottom of the sidebar) back up or move your library as JSON.
- It does **not** fetch lyrics — you paste them in. That keeps it clear of
  copyright and keeps the focus on the romanization rendering.
