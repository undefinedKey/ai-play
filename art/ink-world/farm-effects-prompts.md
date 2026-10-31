# v0.22 farm and world effects generation prompts

Method: built-in `image_gen`, transparent background requested for both new atlases. Original art; no official game artwork used as an input. Original generated PNGs are copied byte-for-byte, with atlas rectangles/anchors described in code; no programmatic pixel edits.

## Crop and independent prop atlas

```text
Use case: stylized-concept
Asset type: production game sprite atlas, 1536x1024 transparent PNG, 4 columns x 3 rows.
Primary request: ORIGINAL hand-drawn survival-game paper-cut artwork, reminiscent of an eerie ink illustrated storybook; visibly irregular bold near-black contour strokes, sharp quirky silhouettes, sparse crosshatching, low-saturation moss leaves, bone cream turnips, ochre wheat, weathered wood and grey cracked stones. Not pixel art, not photorealistic, not 3D, no gloss.
All 12 sprites separated by at least 35 transparent pixels. Each cell is 384px wide and about 341px tall. The entire outside of each sprite must have alpha=0. NO colored backdrop, NO brown halo, NO glow, NO drop shadow, NO grids, NO captions, NO labels. Opaque ink-and-fill objects on true transparency. Keep all complete objects including roots/contact feet inside their own cells.
Draw these exact subjects in row-major order:
ROW 1: (1) uncultivated little dark-earth clod with wiry weeds, (2) freshly hoed small uneven earth clod with 3 furrows but no plants, (3) seeded turnip on a small earth clod with two tiny shoots, (4) growing young turnip with small light root and four moss-green leaves.
ROW 2: (1) mature harvest-ready turnip with bulbous cream root, muted violet shoulder and broad expressive leaves; (2) uncultivated wheat bed clod with wiry dry weeds, (3) freshly hoed wheat earth clod with 3 furrows but no plants, (4) seeded wheat with three little green shoots.
ROW 3: (1) growing young wheat stalks with thin green leaves but no ears, (2) mature golden wheat stalk cluster with heavy crooked seed heads, (3) a complete crooked wooden park bench with high uneven backrest and two visible legs, (4) a complete standalone broken ancient stone column with thick uneven stone base and cracked upper edge.
First ten crop cells use a consistent earth-clod width of 230px and ground contact center about 285px down within the cell. Growing plants rise from the same clod. The two props fit inside 300x270px and also touch the same lower baseline. Camera slightly top-down 3/4, as free-standing 2D top-down survival-world sprites. Do not connect any neighboring cells. Strong readable silhouettes at small scale. No official game characters, symbols or text.
```

## Fire and discovery atlas

```text
Use case: stylized-concept
Asset type: production sprite animation and discovery atlas, transparent PNG, 1536x1024, exactly 4 columns x 3 rows.
Primary request: ORIGINAL coarse ink illustrated survival-game objects. Thick, angular, irregular near-black outlines, sparse scratchy crosshatching, flat low-saturation paper cutout fills. Eerie woodland storybook style, not pixel art, not photorealism, not 3D, no glow shaders.
Every cell 384x341px, separated by at least 35px absolutely transparent gaps. All non-object pixels alpha=0. No background, no grey checkerboard, no colored haze, NO brown or black halos, no shadows. Opaque objects on genuine transparency. No gridlines or text. Each sprite must remain fully inside its own cell.
ROW 1: Four animation keyframes of the SAME small log campfire. Identical crossed charred logs and low angular rock base, ground contact center at y=290 within cell. The stylized ochre-orange flame changes shape clearly: frame1 leans left low; frame2 tall upright narrow; frame3 splits into two tongues; frame4 low leaning right. Keep base and footprint identical in all four, no light halo, flames are opaque ink-edged flat shapes. About 210px wide, max 255px tall.
ROW 2: (1) exactly the same campfire logs/base fully extinguished, charcoal grey ash and NO flame; (2) closed crooked wooden supply chest with rope, no padlock text; (3) same chest opened and visibly empty; (4) small wild vegetable garden mound with mature leafy turnips and wild golden grain.
ROW 3: (1) same wild garden after gathering, a mostly empty uneven earth mound and a few trimmed stems; (2) little natural spring, a crooked dark rock with a narrow stream into a small irregular muted blue-green pool; (3) same spring after being visited, same water and rock, with a tiny flat pale stone by its edge; (4) completely empty transparent cell, no subject.
For rows2-3, every object fits within 280x260px and contacts the ground center near y=290 within its cell. Slight top-down 3/4 viewpoint, readable small sprites. All objects complete and disconnected. No official game designs or symbols.
```

## Farm backdrop

Received from the main task: `exec-f81ed237-1594-49af-a9b0-a2ffc4d6bfcf.png`, copied byte-for-byte to `art/ink-world/farm-ground.png`. The main task records its generation prompt. Dedicated backdrop: open middle, northern fence and tool shed, no baked-in crops or actors.
