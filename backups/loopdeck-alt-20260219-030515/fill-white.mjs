import { discover } from 'loupedeck'

function hsvToRgb(h, s, v) {
  const c = v * s
  const hh = (h % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))

  let r = 0
  let g = 0
  let b = 0

  if (hh >= 0 && hh < 1) [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]

  const m = v - c
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

function rgbTo565(r, g, b) {
  const r5 = (r >> 3) & 0x1f
  const g6 = (g >> 2) & 0x3f
  const b5 = (b >> 3) & 0x1f
  return (r5 << 11) | (g6 << 5) | b5
}

function makeSolidRgb565Buffer(width, height, rgb565) {
  const totalPixels = width * height
  const buffer = Buffer.alloc(totalPixels * 2)
  for (let i = 0; i < totalPixels; i += 1) {
    buffer.writeUInt16LE(rgb565, i * 2)
  }
  return buffer
}

function gradientColor(index, total) {
  const denom = Math.max(1, total - 1)
  const hue = (index / denom) * 300
  const { r, g, b } = hsvToRgb(hue, 1, 1)
  return { r, g, b, rgb565: rgbTo565(r, g, b), hue }
}

async function main() {
  const device = await discover({ autoConnect: false })
  await device.connect()
  await device.setBrightness(1).catch(() => {})

  const keyCount = device.columns * device.rows
  const hasLeft = Boolean(device.displays?.left)
  const hasRight = Boolean(device.displays?.right)

  const segments = []
  if (hasLeft) segments.push({ type: 'screen', id: 'left' })
  for (let key = 0; key < keyCount; key += 1) {
    segments.push({ type: 'key', id: key })
  }
  if (hasRight) segments.push({ type: 'screen', id: 'right' })

  console.log(`Connected: ${device.type}`)
  console.log(`Applying gradient across ${segments.length} zones`) 

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]
    const color = gradientColor(i, segments.length)

    if (seg.type === 'key') {
      const size = device.keySize
      const buffer = makeSolidRgb565Buffer(size, size, color.rgb565)
      await device.drawKey(seg.id, buffer)
      console.log(`Key ${seg.id} <- hue ${color.hue.toFixed(1)}`)
    } else {
      const screen = device.displays[seg.id]
      const buffer = makeSolidRgb565Buffer(screen.width, screen.height, color.rgb565)
      await device.drawScreen(seg.id, buffer)
      console.log(`Screen ${seg.id} <- hue ${color.hue.toFixed(1)}`)
    }
  }

  console.log('Gradient applied successfully.')
  await device.close()
}

main().catch((err) => {
  console.error('Failed:', err?.message || err)
  process.exitCode = 1
})
