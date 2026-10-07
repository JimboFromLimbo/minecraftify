# Minecraftify

Chrome extension that replaces real estate listing photos with AI-generated Minecraft versions. Photos are re-rendered through an [OpenRouter](https://openrouter.ai) image model, cached locally, and swapped in place on the page.

## Why?
Its funny, and Jelly said it would be funny. 

## Example

| **Before**                     | **After**                      |
|-------------------------------|-------------------------------|
| ![Before](/docs/before.png)   | ![After](/docs/after.png)     |

## Supported sites

Zillow, Redfin (.com / .ca), Realtor.com, Realtor.ca, Trulia, Homes.com, Compass, Apartments.com, Rightmove, Zoopla, OnTheMarket, realestate.com.au, Domain, Idealista, Airbnb.

## Setup

1. Get an API key from [openrouter.ai/keys](https://openrouter.ai/keys).
2. Either enter it in the extension popup, or put it in `.env`:

   ```sh
   cp .env.example .env
   # edit .env and set OPENROUTER_API_KEY
   npm run env   # writes extension/config.json
   ```

3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
4. Browse to a listing. Photos turn into Minecraft as they're generated.

After changing `.env`, run `npm run env` again and reload the extension.

## Example

`.env`:

```sh
OPENROUTER_API_KEY=sk-or-v1-abc123...
OPENROUTER_MODEL=black-forest-labs/flux.2-klein-4b
```

```sh
$ npm run env
Wrote extension/config.json (OPENROUTER_API_KEY, OPENROUTER_MODEL)
```

Then open any Zillow listing, e.g. `https://www.zillow.com/homedetails/...`. The hero photo shows a loading state, then swaps to a blocky voxel version with the same camera angle and layout. Opening the gallery is instant because off-screen photos are pre-generated in the background.

## Settings

All settings live in the popup. Blank fields fall back to `.env`, then built-in defaults.

| Setting | Default | Notes |
| --- | --- | --- |
| Enabled | on | Toggle swapping without uninstalling |
| API key | from `.env` | OpenRouter key |
| Model | `OPENROUTER_MODEL` or `google/gemini-3.1-flash-image` | Any OpenRouter image model |
| Parallel requests | 1 | 1–10 |
| Pre-generate off-screen photos | 30 | Per page; 0 = on-screen only |
| Prompt | Minecraft re-render prompt | Customize the style |

**Clear cache** removes all stored generated images. The popup footer shows cache size and total generations.

## Benchmarking models

Compare speed and cost of candidate models on one photo:

```sh
npm run bench -- ./house.jpg
npm run bench -- https://example.com/listing.jpg google/gemini-2.5-flash-image openai/gpt-image-1-mini
```

Reads the key from `.env`. Outputs go to `bench-out/`. Each model run is a paid generation.

## How it works

- `extension/content.js` finds listing photos, generates on-screen ones first, then pre-generates the rest.
- `extension/background.js` runs a two-lane priority queue (on-screen first), fetches and downscales source images, calls OpenRouter, and caches results in `chrome.storage.local`.
- `extension/canon.js` maps the many size/crop variants of one photo to a single id, so each photo is generated once and reused across thumbnails, hero, and fullscreen.

## Privacy

Listing images are sent to OpenRouter and the selected model provider. Your API key is stored in `chrome.storage.local` or `extension/config.json` (gitignored).
