// The ten D8 categories, as a generator installed into the page. Deterministic, so every engine sees
// the same pixels, and committed as code rather than as fixture bytes: D8's method names the
// categories, and a generator is the reproducible form of "ten representative PNGs".
//
// Extracted from run.mjs so the same content can be rendered for inspection without re-running the
// whole measurement.

export function installGenerators() {
  const random = (seed) => () => {
    seed = (seed * 1103515245 + 12345) >>> 0
    return seed / 4294967296
  }

  /** Canvas-drawn content, forced opaque: WebKit's getImageData returns alpha 254 on thousands of
   * pixels of a fully opaque drawing (T26), which would make the frame differ by engine. */
  const fromCanvas = (width, height, draw) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    draw(ctx, width, height)
    const pixels = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255
    return pixels
  }

  const analytic = (width, height, fn) => {
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const rgba = fn(x, y)
        pixels.set(rgba, (y * width + x) * 4)
      }
    }
    return pixels
  }

  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))

  window.t27Generate = (kind, width, height) => {
    let pixels

    if (kind === 'screenshot-light') {
      pixels = fromCanvas(width, height, (ctx, w, h) => {
        ctx.fillStyle = '#f4f5f7'
        ctx.fillRect(0, 0, w, h)
        const header = ctx.createLinearGradient(0, 0, w, 0)
        header.addColorStop(0, '#2b4c7e')
        header.addColorStop(1, '#567ebb')
        ctx.fillStyle = header
        ctx.fillRect(0, 0, w, 72)
        ctx.fillStyle = '#ffffff'
        ctx.font = '30px sans-serif'
        ctx.fillText('Compression settings', 32, 47)
        for (let row = 0; row < 12; row += 1) {
          const y = 104 + row * 52
          ctx.fillStyle = row % 2 ? '#ffffff' : '#eceef2'
          ctx.fillRect(32, y, w - 64, 44)
          ctx.fillStyle = '#1d1f24'
          ctx.font = '19px sans-serif'
          ctx.fillText(`Option ${row + 1}: quality, dimension rule and output format`, 48, y + 29)
          ctx.fillStyle = '#3a7bd5'
          ctx.beginPath()
          ctx.arc(w - 72, y + 22, 12, 0, Math.PI * 2)
          ctx.fill()
        }
      })
    } else if (kind === 'screenshot-dark') {
      pixels = fromCanvas(width, height, (ctx, w, h) => {
        ctx.fillStyle = '#14161c'
        ctx.fillRect(0, 0, w, h)
        ctx.fillStyle = '#1e2029'
        ctx.fillRect(0, 0, 220, h)
        ctx.fillStyle = '#c8ccd8'
        ctx.font = '18px monospace'
        for (let row = 0; row < 20; row += 1) {
          ctx.fillStyle = row % 3 === 0 ? '#7fd1a0' : '#c8ccd8'
          ctx.fillText(`const value${row} = compress(image, ${row * 7});`, 250, 60 + row * 32)
          ctx.fillStyle = '#4a4f60'
          ctx.fillText(String(row + 1).padStart(3, ' '), 236 - 40, 60 + row * 32)
        }
        // A bar chart: flat fills with hard edges, the case a palette handles perfectly.
        const bars = [0.8, 0.45, 0.62, 0.3, 0.91, 0.55, 0.7]
        bars.forEach((value, index) => {
          ctx.fillStyle = ['#e06c75', '#61afef', '#98c379'][index % 3]
          ctx.fillRect(40, 60 + index * 44, 140 * value, 28)
        })
      })
    } else if (kind === 'logo-hard-alpha') {
      // A flat mark on a fully transparent field, binary alpha, no antialiasing.
      pixels = analytic(width, height, (x, y) => {
        const cx = width / 2
        const cy = height / 2
        const r = Math.hypot(x - cx, y - cy)
        const ring = r > height * 0.22 && r < height * 0.34
        const bar = Math.abs(y - cy) < height * 0.05 && Math.abs(x - cx) < height * 0.3
        const inside = ring || bar
        return inside ? [232, 76, 61, 255] : [0, 0, 0, 0]
      })
    } else if (kind === 'logo-soft-alpha') {
      // The same mark with analytic antialiasing and a soft shadow: continuous alpha, three colours.
      pixels = analytic(width, height, (x, y) => {
        const cx = width / 2
        const cy = height / 2
        const r = Math.hypot(x - cx, y - cy)
        const edge = (value, at, softness) =>
          Math.max(0, Math.min(1, (softness - Math.abs(value - at)) / softness))
        const inner = height * 0.22
        const outer = height * 0.34
        const ring =
          r > inner && r < outer ? 1 : Math.max(edge(r, inner, 2.5), edge(r, outer, 2.5))
        const shadow = Math.exp(-((r - outer * 1.05) ** 2) / (2 * 26 ** 2)) * 0.35
        const alpha = clamp(Math.max(ring, shadow) * 255)
        const mix = ring > shadow ? [232, 76, 61] : [20, 24, 40]
        return [mix[0], mix[1], mix[2], alpha]
      })
    } else if (kind === 'illustration-flat') {
      const palette = [
        [247, 243, 233],
        [40, 54, 72],
        [225, 112, 85],
        [116, 185, 155],
        [253, 203, 110],
        [45, 152, 218],
      ]
      pixels = analytic(width, height, (x, y) => {
        const band = Math.floor((y * 6) / height)
        const wedge = Math.floor(((x + y * 0.4) * 5) / width) % 6
        const c = palette[(band + wedge) % palette.length]
        return [c[0], c[1], c[2], 255]
      })
    } else if (kind === 'illustration-shaded') {
      pixels = analytic(width, height, (x, y) => {
        const u = x / width
        const v = y / height
        const shade = 0.55 + 0.45 * Math.sin(u * 3.1) * Math.cos(v * 2.3)
        const hill = v > 0.55 + 0.1 * Math.sin(u * 7)
        const base = hill ? [76, 122, 84] : [140, 196, 230]
        return [clamp(base[0] * shade), clamp(base[1] * shade), clamp(base[2] * shade), 255]
      })
    } else if (kind === 'gradient-sky') {
      pixels = analytic(width, height, (x, y) => {
        const t = y / (height - 1)
        const u = x / (width - 1)
        return [
          clamp(30 + t * 205 + u * 12),
          clamp(85 + t * 140 + u * 8),
          clamp(205 - t * 55 + u * 4),
          255,
        ]
      })
    } else if (kind === 'gradient-mono') {
      // A single grey ramp: the worst case for banding, and the easiest to measure it on.
      pixels = analytic(width, height, (x) => {
        const level = clamp((x * 255) / (width - 1))
        return [level, level, level, 255]
      })
    } else if (kind === 'diagram') {
      pixels = fromCanvas(width, height, (ctx, w, h) => {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.strokeStyle = '#333a44'
        ctx.lineWidth = 1
        for (let i = 0; i < 26; i += 1) {
          ctx.beginPath()
          ctx.moveTo(20, 20 + i * 28)
          ctx.lineTo(w - 20, 20 + i * 28)
          ctx.stroke()
        }
        ctx.strokeStyle = '#1f6feb'
        ctx.lineWidth = 2
        for (let i = 0; i < 9; i += 1) {
          ctx.strokeRect(60 + i * 100, 60 + (i % 4) * 140, 84, 96)
        }
        ctx.fillStyle = '#111111'
        ctx.font = '14px sans-serif'
        for (let i = 0; i < 9; i += 1) {
          ctx.fillText(`node ${i}`, 70 + i * 100, 112 + (i % 4) * 140)
        }
      })
    } else {
      // A photographic stand-in: smooth structure plus sensor-like noise, many distinct colours.
      const next = random(2027)
      pixels = analytic(width, height, (x, y) => {
        const u = x / width
        const v = y / height
        const n = () => (next() - 0.5) * 18
        return [
          clamp(118 + 92 * Math.sin(u * 5.3) + 36 * v + n()),
          clamp(104 + 74 * Math.cos(v * 4.7) + 28 * u + n()),
          clamp(126 + 64 * Math.sin((u + v) * 3.9) + n()),
          255,
        ]
      })
    }

    return {
      width,
      height,
      pixels,
      colour: { kind: 'untagged' },
      sourceOrientation: { kind: 'absent' },
    }
  }
}
