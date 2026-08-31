const assert = require('node:assert/strict')
const { deflateSync } = require('node:zlib')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const outputDirectory = path.resolve(
  __dirname,
  '..',
  '..',
  'miniprogram',
  'test-assets',
  'pattern-generation',
)

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

function encodePng(width, height, pixelAt) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4)
    row[0] = 0
    for (let x = 0; x < width; x += 1) {
      const rgba = pixelAt(x, y)
      const offset = 1 + x * 4
      row[offset] = rgba[0]
      row[offset + 1] = rgba[1]
      row[offset + 2] = rgba[2]
      row[offset + 3] = rgba[3]
    }
    rows.push(row)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const assets = [
  {
    name: '01-square-flat.png',
    width: 64,
    height: 64,
    pixelAt: () => [51, 102, 153, 255],
  },
  {
    name: '02-landscape-two-color.png',
    width: 96,
    height: 48,
    pixelAt: (x) => x < 48 ? [220, 48, 64, 255] : [32, 96, 224, 255],
  },
  {
    name: '03-portrait-two-color.png',
    width: 48,
    height: 96,
    pixelAt: (_x, y) => y < 48 ? [36, 180, 96, 255] : [248, 196, 48, 255],
  },
  {
    name: '04-alpha-edge.png',
    width: 64,
    height: 64,
    pixelAt: (x) => {
      if (x < 16) return [255, 0, 0, 0]
      if (x < 32) return [255, 0, 0, 31]
      if (x < 48) return [0, 200, 80, 32]
      return [0, 80, 255, 255]
    },
  },
  {
    name: '05-gradient.png',
    width: 128,
    height: 64,
    pixelAt: (x, y) => {
      const red = Math.round(x * 255 / 127)
      const green = Math.round(y * 255 / 63)
      return [red, green, 255 - red, 255]
    },
  },
  {
    name: '06-detail-pattern.png',
    width: 96,
    height: 96,
    pixelAt: (x, y) => {
      if ((x - 48) ** 2 + (y - 48) ** 2 < 9 ** 2) return [0, 0, 0, 0]
      if (x === y || x + y === 95 || x % 16 === 0 || y % 16 === 0) {
        return [20, 20, 24, 255]
      }
      return (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0
        ? [244, 236, 220, 255]
        : [128, 72, 176, 255]
    },
  },
]

function main() {
  const checkOnly = process.argv.includes('--check')
  if (!checkOnly) mkdirSync(outputDirectory, { recursive: true })

  assets.forEach((asset) => {
    const expected = encodePng(asset.width, asset.height, asset.pixelAt)
    const outputPath = path.join(outputDirectory, asset.name)
    if (checkOnly) {
      assert.ok(existsSync(outputPath), `Missing generated fixture: ${asset.name}`)
      assert.deepEqual(readFileSync(outputPath), expected, `Fixture changed: ${asset.name}`)
      return
    }
    writeFileSync(outputPath, expected)
  })

  console.log(`${checkOnly ? 'Verified' : 'Generated'} ${assets.length} pattern fixtures.`)
}

main()
