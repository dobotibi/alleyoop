<p align="center"><img src="docs/img/alleyoop-plugin-icon-256.png" width="96" alt="Alleyoop"></p>

# Alleyoop + Dunk

Figma frames to clean, layered Illustrator files, for After Effects.

**Alleyoop** is the Figma plugin. It makes the pass.
**Dunk** is a small helper app on your computer. It takes the pass, and Adobe Illustrator writes the `.ai` file.

Website and download: **https://dobotibi.github.io/alleyoop/**

## Why

I am an art director. Almost every week I send Figma designs to animators. And every time it was the same: export a PDF, open it in Illustrator, delete the clipping masks nobody asked for, the black masks, the frame clips. Rename every layer. Then export a separate SVG, because the text came out outlined.

It took a lot of time. And with complex or raster graphics it often went wrong. So I built this.

## What you get

- One `.ai` file per frame. Select more frames, you get more files in one go.
- Every element of the frame is its own top-level layer, with its Figma name. After Effects sees them as separate layers.
- Useless clipping masks are removed, empty groups are deleted, single-child groups are unwrapped.
- Text: **editable**, **outlined**, or **both** (outlined visible, editable hidden under it).
- Layer names are ASCII only, so nothing breaks in After Effects scripts.

## How it works

```
Figma (Alleyoop plugin) ──localhost:47800──▶ Dunk (menu bar app) ──▶ Adobe Illustrator ──▶ Desktop/Alleyoop/<frame>.ai
```

The plugin exports each element at full frame size (PDF for vectors, PNG for blurred or raster parts, SVG for live text) and sends it to Dunk. Dunk runs a script in Illustrator. Illustrator builds the layers, cleans the masks and saves the file. Everything stays on your computer.

## Requirements

- macOS 12 or newer (Apple silicon or Intel). Windows version: in testing, coming later.
- Adobe Illustrator 2024, 2025 or 2026.
- Figma desktop app (recommended).

## Install

1. Download Dunk from the [releases](https://github.com/dobotibi/alleyoop/releases/latest) and drag it to **Applications**.
2. Dunk is not signed yet. The first time macOS blocks it. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.
3. On the first job macOS asks if Dunk can control Illustrator. Click **Allow**.
4. In Figma, run **Alleyoop** from the Community (or, for development: **Plugins → Development → Import plugin from manifest…** and pick `figma-plugin/manifest.json`).

## Use

1. Select one or more frames.
2. Choose the text mode and where to save (**Default folder** or **Ask when done**).
3. Click **Send to Illustrator**.

The default folder is `Desktop/Alleyoop`. You can change it in the Dunk menu.

### One rule for layers

The direct children of the frame become the layers. If you want a group split into its children, start its name with `+` (for example `+Icons`). It works on nested groups too.

### Known limits

- Background blur and some Figma effects are exported as raster (PNG).
- A Figma mask on frame level can't always stay a mask when its layers go to separate layers. The plugin warns you before export.
- Multi-line text is one text frame per line.

## Problems

- The plugin says "Dunk is not running": start Dunk, it lives in the menu bar.
- Dunk menu → **Diagnostics** writes a short report and opens it.
- Error messages end with the path of the log file. The log is at `~/Library/Application Support/Dunk/logs/json-maclane.log`.
- Please open an [issue](https://github.com/dobotibi/alleyoop/issues) and attach the log.

## Build from source

```bash
cd dunk
npm install
npm start          # run Dunk without building
npm run dist:mac   # build the .dmg
```

Tests (no Illustrator needed):

```bash
node tests/naming.test.js
node tests/win/win-adapter.test.js
```

## Privacy

Alleyoop and Dunk send nothing to the internet. The plugin only talks to Dunk on `localhost`. No analytics, no account. Details: [privacy](https://dobotibi.github.io/alleyoop/privacy.html).

## License

MIT. Made by [Tibor Dobozi](https://github.com/dobotibi).
Adobe Illustrator and After Effects are trademarks of Adobe. Figma is a trademark of Figma, Inc. This project is not affiliated with either.
