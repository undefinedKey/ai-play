# Original Q World artwork

This directory authors the native pixel artwork used by release 0.34.0. The
drawings are original integer-pixel clusters; no commercial sprites or archived
ink images are traced, resized, recolored, or embedded in these textures.

Run `node scripts/build-q-world.mjs` from the repository root. The generator
writes `public/pixel-world/q_*.png`, matching `.atlas.json` metadata, the current
`manifest.json`, and `src/q-service-art.js`. It also writes an inspection sheet
to `artifacts/q-world/scenery-contact.png`. `--output=<directory>` supports a
separate reproducibility check. Generated PNGs and source metadata are committed;
edit the authoring code, not the generated textures.

- `scenery.mjs` owns original outdoor grounds, buildings, trees, resource stages,
  crops, icons, campfires, discoveries, and public service/mechanism art.
- `actors.mjs` packs the original character, monster, equipment and tool drawings
  from `src/q-actor-art.js` into synchronized directional animation sheets.
- `shared/maps/*`, `shared/journey-layout.js` and the existing trail centerlines
  in `src/wilderness-art.js` supply geometry. Artwork does not change collision,
  travel endpoints, interaction radii, homes, inventories, or AI decisions.

Every active PNG has a SHA256 entry in the manifest. Atlas frames record native
source bounds and measured contact anchors; the runtime uses nearest sampling.
The public service atlas preserves separate gate, bridge, rune, key and relic
states. Static market furniture contains notices, and picnic furniture contains
empty dishes: availability of food and goods is determined by the world state.

Historical Pixelbolt and ink assets remain on disk for archived releases. The
current Q manifest references only `q_` PNGs. Home furniture and the side-view
journey keep their existing perspectives and use their own original native
pixel geometry under the same `docs/ART-DIRECTION.md` requirements.
