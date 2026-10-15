// One-off icon generation from the repo's logo (../assets/logo.png). Run from app/: npm run icons
//
// The full logo is a wide mark with a wordmark, too fine to read at icon sizes, so the icons use its lens
// (the ship in the telescope). Everything is derived from that one crop: never export sizes by hand.
//
//   build/icon.png   1024 px  electron-builder makes the .ico/.icns from this (installer and app icon)
//   assets/icon.png   256 px  the window and taskbar icon while running
//   assets/logo.png   128 px  shown beside the title inside the app
//   ../assets/logo-hero.png   the full logo on a dark panel, for the README (its lettering is white, so it
//                             needs a dark background to be read on GitHub's light theme)

import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const SRC = here('../../assets/logo.png')

// The lens in the 1118 x 668 logo: its bounding box, then an ellipse inside it that drops the telescope
// barrel and anything else that is not the lens.
const LENS = { left: 735, top: 0, width: 383, height: 455 }

const lens = await sharp(SRC).extract(LENS).toBuffer()
const mask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${LENS.width}" height="${LENS.height}">` +
    `<ellipse cx="${LENS.width / 2}" cy="${LENS.height / 2}" rx="${LENS.width / 2 - 1}" ry="${LENS.height / 2 - 1}" fill="#fff"/></svg>`,
)
const cut = await sharp(lens).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()

// Pad to a square canvas, transparent, so nothing is cropped or stretched.
const side = Math.max(LENS.width, LENS.height)
const square = await sharp(cut)
  .extend({
    top: Math.floor((side - LENS.height) / 2),
    bottom: Math.ceil((side - LENS.height) / 2),
    left: Math.floor((side - LENS.width) / 2),
    right: Math.ceil((side - LENS.width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer()

mkdirSync(here('../build'), { recursive: true })
mkdirSync(here('../assets'), { recursive: true })
await sharp(square).resize(1024, 1024).toFile(here('../build/icon.png'))
await sharp(square).resize(256, 256).toFile(here('../assets/icon.png'))
await sharp(square).resize(128, 128).toFile(here('../assets/logo.png'))
console.log('Icons generated.')

// The README hero: the whole logo, padded, on the dark colour of the report page.
const hero = await sharp(SRC)
  .resize({ width: 900 })
  .extend({ top: 48, bottom: 48, left: 64, right: 64, background: { r: 13, g: 17, b: 23, alpha: 1 } })
  .png()
  .toBuffer()
await sharp(hero).toFile(here('../../assets/logo-hero.png'))
