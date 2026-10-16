# DeltaFront brand assets

| File                         | Used for                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `deltafront-logo.png`        | Horizontal wordmark (4000×601, transparent): desktop hero, mobile top bar and menu drawer, Steam promo strip        |
| `deltafront-icon.png`        | Triangular emblem (2048×1792, transparent): game-starting (loading) screen. Source for the three files below        |
| `deltafront-favicon.png`     | Browser-tab icon, 64×64 square, derived from the icon                                                               |
| `deltafront-icon-192.png`    | Web-app manifest icon, 192×192 square, derived from the icon                                                        |
| `deltafront-icon-512.png`    | Web-app manifest icon, 512×512 square, derived from the icon                                                        |
| `deltafront-logo-readme.png` | The wordmark on the dark brand background, for the README (the logo's white letters vanish on GitHub's light theme) |

These are DeltaFront's own artwork. The logo and the icon are the sources: to replace either, keep the file name, then regenerate the derived files (the icon is not square, so the square ones are padded with transparency):

```sh
cd resources/images/branding
for spec in 512:deltafront-icon-512.png 192:deltafront-icon-192.png 64:deltafront-favicon.png; do
  magick deltafront-icon.png -background none -gravity center -extent 2048x2048 \
    -filter Lanczos -resize ${spec%%:*}x${spec%%:*} -strip PNG32:${spec#*:}
done
magick deltafront-logo.png -resize 1400x -background '#090909' -alpha remove -alpha off \
  -bordercolor '#090909' -border 80x60 -strip PNG24:deltafront-logo-readme.png
```

If the icon's size changes, change `2048x2048` to its longer side. The files are drawn with smooth scaling (not `image-rendering: pixelated`), because they are shown far smaller than their size, where nearest-neighbour scaling drops thin lines.

The logo is white and red on transparency, so it is made for the dark UI. It displays about 28–60 px tall.

These files sit under `resources/`, which the repository licenses as CC BY-SA 4.0 by default (see `LICENSE-ASSETS`). If DeltaFront's logo and icon should stay under different terms, move them to a separate folder with its own license and update the asset paths.
