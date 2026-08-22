# WhyDunit — web

Static Next.js front end. Two routes: the story (`/`) and the live dashboard
(`/dashboard`). Both render from `src/data/snapshot.json`, which is generated
from the real pipeline artifacts — no number is typed by hand.

```bash
npm run snapshot      # from the repo root: data/*.json -> web/src/data/snapshot.json
cd web && npm install && npm run dev
```

Deploy: `npm run build` emits a fully static `out/`. On Vercel, set the root
directory to `web`. Netlify, Cloudflare Pages and GitHub Pages all work too —
there is no server, because the site is a read-only view of a committed snapshot.

## Refreshing the numbers

```bash
npm run all && npm run verify && npm run snapshot
```

The snapshot carries a provenance block — seed, horizon, date and the reference
manifest hash — so a stale deploy is visible in the footer rather than silent.

## Dropping in video

`src/components/VideoBeat.tsx` scrubs a clip by scroll position and falls back to
its SVG children if the file is missing or the browser refuses to seek. The page
is complete with no video at all, so clips are an enhancement and never a
dependency.

Put clips in `public/video/` and wrap the fallback:

```tsx
<VideoBeat src="/video/04-dial.mp4">
  <Dial failHour={11.12} fixHour={14.12} />
</VideoBeat>
```

Encode for seeking — a long GOP makes scrubbing stutter:

```bash
ffmpeg -i in.mov -an -c:v libx264 -crf 20 -g 6 -keyint_min 6 \
  -pix_fmt yuv420p -movflags +faststart -vf scale=1920:1080 out.mp4
```

Keep every figure in the DOM rather than burnt into the video, so the numbers
stay tied to the snapshot and update when the pipeline reruns.
