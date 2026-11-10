# Mixmaker

This is a demo of some of schema.fm's capabilities. (see https://docs.schema.fm)
-- it allows a user to get two tracks, mash them together, then reupload them
(with new cover art) to the mixmaker site.

Mixmaker's design should be modern, dark mode. Think spotify or another music
site that appeals to the 18-30 demographic.

Because this is a demo, it doesn't need to be full featured: no user login, no
playlists. Just present two tracks on the left and right. Allow the user (on the
web) to pick two tracks, mix them together, can you do browser-based stem
separation? that would be rad. If not, the rust API could do stem separation and
present each stem to the user.

then, they can manipulate the two tracks, and re-upload. the metadata and
contributors from EACH TRACK should be combined into the new work, tracking
provenance.

API should be built in rust with axum. Front end should be a single page app,
Typescript + React.

Call it mix-maker.

---

## What's built

```
web (React + TS, Vite :5175) ──/api──▶ api (Rust/axum :8090) ──GraphQL──▶ //SCHEMA catalog-api
                                             │                                  │
                                             ├─ demucs (stem separation)        └─ media-worker (AAC encodings)
                                             └─ ffmpeg (WAV → FLAC master)
```

**Studio**: two decks, A on the left and B on the right, each picking from the live
//SCHEMA catalog. Each deck has:

- a waveform. Click it to set where the deck starts in its source.
- **Split stems**: runs [demucs](https://github.com/adefossez/demucs) (htdemucs)
  on the API host and gives four faders: vocals, drums, bass and other. Each one
  can be muted. Stems are cached, so a track only has to be split once.
- knobs for volume, tempo (±30%), a DJ filter (low-pass ↔ high-pass) and
  "enter at", which offsets the deck inside the mix.

The center mixer has an equal-power crossfader. You can automate an A → B
transition across the middle of the mix, or set the fader by hand. It also has a
mix length, a rough BPM estimate per deck with **Sync B → A**, and a live
spectrum.

**Publish**: the browser renders the mix offline with the same WebAudio graph
you've been listening to (what you hear is what ships). It generates cover art
from both source covers, in four styles with an adjustable hue. The API then:

1. reads both source releases back from //SCHEMA. Provenance comes from the
   catalog, not from the browser.
2. `createRelease` makes a new Single with a generated UPC, carrying the labels
   from both sources plus a combined ℗ line and a combined © line.
3. `createParty` adds the remixer.
4. `creditRelease` copies every release-level credit from both sources, keeping
   each one's `roleKind`, and adds the remixer.
5. `addResource` adds the track and the cover.
6. `creditResource` copies every track-level credit from both source
   recordings and adds the remixer as `Remixer`.
7. `updateResource` sets the track ℗, which incorporates both sources' ℗.
8. `requestUpload` → PUT → `completeUpload` stores the FLAC master and the PNG
   cover, bound to their SHA-256.
9. `publishRelease` puts it live.

The UI then replays this trace. Mixmaker also writes its own provenance
record to `data/mixes.json`. It holds the exact source UPCs, resource ids and
ISRCs, plus the "recipe" (stem levels, tempo, offsets, crossfade, cover style).
//SCHEMA has no first-class "derived from" link yet (see notes below).

**Drops**: a gallery of published mixes. Each one is read back live from
//SCHEMA (state, credits, labels, ℗/©), with its lineage, recipe and the full
operation trace. Published mixes also show up in the deck pickers tagged
`mix`, so you can remix a remix.

## Running it locally

You need: Rust, Node 20+, ffmpeg, Python 3, Docker, and `../schema` checked out
and built.

```sh
# 1. //SCHEMA locally (catalog-api :8081 + media workers), against compose's db + minio
./scripts/schema-local.sh

# 2. An API key (dev catalog). Scopes are comma-separated.
cd ../schema && SCHEMA_DATABASE_URL=postgres://postgres:example@localhost/schema \
  cargo run -q -p auth --example mint_key -- dev "mixmaker" catalog_read,catalog_write,media_read,media_write
#    → put it in mixmaker/.env:
#      SCHEMA_API_URL=http://localhost:8081/graphql
#      SCHEMA_API_KEY=sk_...

# 3. demucs (one-time; ~1 GB with torch)
python3 -m venv .venv && .venv/bin/pip install demucs soundfile

# 4. mix-maker
./scripts/dev.sh        # → http://localhost:5175
```

To point at production or staging instead, set `SCHEMA_API_URL` to
`https://api.schema.fm/graphql` and use a key from the console.

## Notes and known gaps

- **Lossless.** A `media_read` key can't pull lossless originals, and the dev
  org isn't a lossless org. So mix-maker plays the AAC-256 encodings, and a
  track shows "encoding…" until the media-worker has made its AAC. Published
  mixes play from mix-maker's local FLAC until their own AAC exists.
- **Stem separation runs on the server, not in the browser.** In-browser demucs
  (ONNX/WebGPU) is possible but heavy for a 90-minute build. Server-side htdemucs
  on Apple-silicon MPS takes about 1 to 3 minutes per track after the first
  model download. Results are cached in `data/stems/`.
- **One ℗ and one © line per language/territory.** //SCHEMA rejects two ℗ lines
  for the same territory, so the sources' lines are folded into one line:
  `(P) 2026 DJ X via mix-maker, incorporating (P) 2024 A; (P) 2025 B`.
- **`Remixer` isn't a `DisplayArtistRole`.** At release level the remixer is
  credited as `Artist`. On the track they're credited as `Remixer`
  (`ResourceContributorRole`).
- **No first-class provenance in //SCHEMA.** A `derivedFrom` / `samples`
  relation on Release or Resource (ERN has `RelatedRelease` / `RelatedResource`)
  would let the lineage live in the catalog instead of in `data/mixes.json`.
  That would be a nice schema feature to show off next.
- BPM detection is a rough autocorrelation estimate, good enough to suggest a
  tempo match.
