# Dressing Room

[![CI](https://github.com/StringXD/dressing-app/actions/workflows/ci.yml/badge.svg)](https://github.com/StringXD/dressing-app/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[中文](README.md) | **English**

Upload a full-body photo, swap in different clothes and hairstyles, and see the result directly.

A **complete, self-hostable AI try-on application**: a conversational Agent as the entry point, with a job queue, cost visibility and a model registry. It does not depend on any platform's data API — you upload the photos and the garment images yourself, and the models are responsible for understanding them.

---

## Project status

**The core functionality is already usable: clone it, configure the two Keys as described in Quick Start, and you can upload a photo → state your requirements in chat → approve the paid call → view the result and the bill.**

| Capability | Status |
|---|---|
| Upload / storage / EXIF stripping | ✅ Usable |
| Provider abstraction layer + model registry | ✅ Usable |
| Job queue + standalone Worker (concurrency cap, crash recovery, retries that don't double-charge) | ✅ Usable, with an end-to-end acceptance script |
| All three fal.ai endpoints measured for real | ✅ Verified with real photos |
| Conversational Agent (AI SDK + tool calls + HITL confirmation) | ✅ Usable — requires `ANTHROPIC_API_KEY`, see Quick Start |
| Chat area / workbench UI (queue panel, batch grid, conversation history) | ✅ Usable |
| Input quality pre-check, AI content marking, cost dashboard | ✅ Usable |
| Per-garment cropping `cropGarment` | 🚧 **Below release standard**, see roadmap phase 6 |
| Self-hosted inference (no fal Key needed) | ⛔ Roadmap |

About the queue: tasks are **claimed globally by enqueue time**, and **strict per-user FIFO is not implemented yet** (pg-boss runs at its default setting; there is no `policy` field in `QUEUE_OPTIONS`). The concurrency cap, crash recovery and "retries don't double-charge" are in place, and an acceptance script pins them down.

---

## Why this project exists

The research conclusion was: **there is no usable open-source "complete try-on app"**, and every existing implementation is demo-grade. ComfyUI has ready-made node packs, but ComfyUI itself is GPL-3.0 and requires the user to hand-wire a dozen or so nodes together.

At the same time, platforms such as Taobao and JD.com have already launched official AI try-on — so this project **is not commercialized**, and does not attempt to scrape data from any platform. It does the "I have a photo, and a garment I want to try" job locally.

---

## Architecture

```
Browser ── upload ──▶ Next.js API ──▶ Postgres ◀── Worker process ──▶ fal.ai
                         │              │              │
                         └── storage (local disk)      └── poll → re-host output → persist
```

**The R2 driver is not implemented yet**: setting `STORAGE_DRIVER` to `r2` throws an error outright. This is deliberate — configuring r2 means the expectation is cloud storage, and silently falling back to local disk would make images "disappear" after going live and be very hard to track down. To add it, **create** a `src/lib/storage/r2.ts` against the `StorageAdapter` interface (that file does not exist yet — it is only the destination referenced by the error message in `index.ts`).

**Why a standalone Worker process is mandatory**: image generation takes anywhere from tens of seconds to several minutes. Putting it inside an HTTP request would run into Vercel/Next function timeouts — and should a job be interrupted just because the user closed the page? It shouldn't. Once a task is enqueued it has an independent lifecycle, the queue lives in Postgres (pg-boss, no Redis needed), and after the process is killed, a restart reconciles and recovers automatically.

**Why outputs must be re-hosted**: what fal returns is a temporary URL on its own CDN, which expires. Without re-hosting, a user coming back the next day finds a gallery full of broken images.

For more design trade-offs and pitfalls, see the comments at the top of each module — this project's habit is to write "why it's done this way" directly next to the code, rather than in a separate document.

---

## Quick start

Prerequisites: **Node 22.12+**, Docker, an API Key for [fal.ai](https://fal.ai/dashboard/keys) (a dual-currency credit card is needed to top up), and an API Key for a **chat model** (`ANTHROPIC_API_KEY`; any endpoint compatible with the Anthropic protocol will do) — the entry page `/chat` will not work without it.

> The Node version floor is determined by the dependencies' `engines`, not written casually: `pg-boss@12` requires `>=22.12.0`, and `ai@7` requires `>=22`.
> `package.json` already declares `engines`, so npm warns you directly when the version is too low.

```bash
git clone https://github.com/StringXD/dressing-app.git
cd dressing-app
cp .env.example .env          # fill in at least FAL_KEY and ANTHROPIC_API_KEY
docker compose up -d postgres
npm install
npm run db:migrate
npm run dev                   # the app, defaults to http://localhost:4000
npm run worker                # in a second terminal: the Worker process
```

The port is 4000 rather than the default 3000 because on Windows, Docker/WSL2 reserves the 2941–3040 port range, and 3000 falls inside it, which makes the bind fail.

**Both processes must be running**: `npm run dev` only starts the Web app; generation jobs are consumed by `npm run worker`.

---

## Models and licensing

This project **does not restrict itself to commercially usable models only** — quality comes first, and you weigh the trade-offs according to your own use case.

| Endpoint | Purpose | Cost per run | License |
|---|---|---|---|
| `fal-ai/fashn/tryon/v1.6` | Try-on (flagship tier) | $0.075 | ✅ Commercial use OK |
| `fal-ai/image-apps-v2/virtual-try-on` | Try-on (economy tier) | $0.040 | ✅ Commercial use OK |
| `fal-ai/image-apps-v2/hair-change` | Hairstyle change | $0.040 | ✅ Commercial use OK |

> ⚠️ **If you need commercial use, pick only the ✅ entries above.**
> The registry allows including `license: 'research'` (no commercial use) models on a "quality first" basis. When such entries do exist,
> **the startup logs print them out on their own** (once on the worker side and once on the web side) —
> you don't need to remember to come back and consult this table, and just cloning and running it won't let you miss them.
> This table is kept in sync, but the only source of truth is always the `license` field of `src/lib/providers/models.config.ts`.

Adding a model = one line in the registry + one function in the mapping table; no need to touch orchestration, the API or the frontend.

---

## Measured data

All of the following are **measured with real photos**, not values quoted from documentation:

| Endpoint | Duration | Output size | Cost |
|---|---|---|---|
| FASHN v1.6 | 71–259s (highly variable) | **equals the input size** | $0.075 |
| Generic try-on (economy tier) | 50.5s | 3072×4096 | $0.040 |
| Hairstyle change | 24.5s | 3072×4096 | $0.040 |

A few pitfalls we hit, worth knowing when choosing a model:

- **FASHN runs pose detection on the person photo**, and non-real-human photos (composites, silhouettes) are rejected with a 422. The error message looks like `body.person_image: Failed to detect body pose in model image.`
- **FASHN's output resolution equals the input resolution.** A 270×360 photo goes in, 270×360 comes out. If you want a crisp preview, you have to make sure the input is crisp first.
- **The economy tier adds details the garment doesn't have in the original image** (in our test it added a chest pocket and white piping to a plain baseball jacket). Choose FASHN for faithfulness, the economy tier for looks — this is a real trade-off.
- **Screenshots of mobile product pages work directly.** In our test, a screenshot with a status bar, a price, an "Add to cart" button and surrounding clutter produced an output that those elements did not leak into at all.

---

## Development

```bash
npm run typecheck      # tsc
npm run lint           # eslint
npm test               # unit tests (pure logic, no network, no cost)
```

### Acceptance scripts

⚠️ **Mind which ones cost money and which don't**, so you don't accidentally burn your own quota:

| Script | Costs money? | Description |
|---|---|---|
| `npm run smoke:upload` | 🆓 | Upload pipeline, including EXIF stripping verification |
| `npm run smoke:queue` | 🆓 | Queue end-to-end: concurrency cap, crash recovery, **retries that don't double-charge**. Uses a stub provider, needs Postgres |
| `npm run smoke:conversations` | 🆓 | Conversation persistence: idempotency (resending the whole history produces no duplicate rows), `seq` ordering, the title written only once, nothing readable across conversations. Needs Postgres |
| `npm run verify:fal-schema` | 🆓 | Validates the parameter mappings and enum vocabularies against fal's official OpenAPI schema |
| `npm run spike:fal` | 💰 | **Really calls the fal endpoints** to verify quality. Use your own photos: `tsx scripts/spike-fal.ts <person photo> [garment image]` |

`smoke:queue` spawns a real worker child process and runs the real code, replacing only "call the upstream" with a fake provider.

> ⚠️ **`smoke:queue` uses a separate queue name (`generation-smoke`) and a fixed test conversation.**
> This isn't fussiness: it once shared the `generation` queue with the real worker, so
> ① a running real worker would claim the test job and really send requests upstream (we caught this in practice);
> ② the cleanup at the start of the script was a whole-table update with no conversation filter, which set **real jobs that were still running**
> to canceled — and some of them may already have been billed upstream.
> Running the acceptance suite does **not** require stopping the worker first, but nor should you have to stop anything in order to run it.

---

## Roadmap

Legend: ✅ Done · 🚧 Partially done · ⛔ Not started

- ✅ **Phase 5**: Conversational Agent layer (AI SDK + tool calls + HITL confirmation)
- 🚧 **Phase 6**: Extending the Agent's capabilities
  - Done: result evaluation `critiqueOutfit`, body type / color season analysis, style suggestions `suggestStyle`,
    whole-look extraction `cloneLook`, result comparison `compareResults`, batch matrix `batchTryOn`,
    input pre-check `inspectPhoto`, fetching past photos `listRecentPhotos`, cost reporting `getCostSummary`
  - `cropGarment` (per-garment cropping) **is implemented but below release standard**: locating a single garment relies on a general vision model's coordinate estimates,
      and the measured precision isn't good enough — a top's box cuts the face in along with it. Both tightening the prompt and "clip using the head box" were tried
      and disproven (clipping tightly cuts off the collar), and fixing it requires switching to a dedicated garment segmentation endpoint
    - Not done: `refineLast` (iterative refinement), `rememberPreference` (preference memory)
- ✅ **Phase 7**: Chat area and workbench UI (queue panel, batch grid) — the "Recent results" section, the comparison slider,
  and the queue panel (including the one still running after a page refresh), plus the workbench multi-select grid, are all done
- ✅ **Phase 8**: Input quality pre-check · cost dashboard (`getCostSummary`) · AI content marking
  (implicit: output images carry EXIF provenance; explicit: a visible badge on the result image)
- ⛔ **Phase 9**: Self-hosted inference, so people without a fal Key can run it too (Leffa / Stable-Hair / Qwen-Image-Edit, etc.)
  - Landing this requires a real, callable inference endpoint. **Nothing that hasn't been measured goes into the registry** —
    the registry is the only basis users have for choosing, and adding something based on documentation alone would create an option no one has verified.

---

## License and acknowledgements

[Apache-2.0](LICENSE) © 2025 StringXD

Image generation capabilities come from [fal.ai](https://fal.ai) and the authors of the individual models hosted there. This repository contains no model weights.

Compliance note: if you provide generative services to the public in mainland China, be aware that 《人工智能生成合成内容标识办法》 (Measures for the Labeling of AI-Generated Synthetic Content) requires both explicit and implicit labeling of generated content. The project provides an `AI_WATERMARK_ENABLED` switch (on by default), but in a self-hosted scenario **compliance responsibility lies with the deployer**.
