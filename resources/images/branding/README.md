# DeltaFront brand assets

| File                  | Used for                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `deltafront-logo.png` | Horizontal wordmark: desktop nav, mobile top bar and menu drawer, Steam promo strip, README |
| `deltafront-icon.png` | Triangular emblem: favicon, web-app manifest icon, game-starting (loading) screen           |

These are DeltaFront's own artwork. To replace either, keep the file name; nothing else needs to change.

Export guidance:

- `deltafront-icon.png`: square PNG with transparency, currently 500×500 (declared as such in `resources/manifest.json`). Installable web apps expect 192×192 and 512×512 icons; add them to the manifest if you want install prompts.
- `deltafront-logo.png`: transparent PNG, currently 866×288 (about 3:1). It displays about 28–40 px tall. For the crispest result, export it at the size where one art pixel is a whole number of screen pixels, rather than a large upscaled image.
- Both render with `image-rendering: pixelated`, so draw them on a pixel grid and avoid anti-aliased edges.

These files sit under `resources/`, which the repository licenses as CC BY-SA 4.0 by default (see `LICENSE-ASSETS`). If DeltaFront's logo and icon should stay under different terms, move them to a separate folder with its own license and update the asset paths.
