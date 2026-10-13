// Run against the actual rendered landing page, not theme tokens alone:
// ego-browser nodejs < frontend/scripts/check_button_contrast.mjs
// CHROMA_QA_SPACE=33 reuses an existing task space; its owner closes it.
// CHROMA_QA_URL=http://localhost:5173/prototype/qa.html selects a local fixture.
// If the broker does not forward environment variables, prepend:
// globalThis.CHROMA_BUTTON_QA = { spaceId: 33, url: 'http://localhost:5173/' }
if (typeof taskSpace !== 'function') {
  throw new Error('Run this script with ego-browser nodejs via stdin.')
}

const config = globalThis.CHROMA_BUTTON_QA || {}
const spaceId = config.spaceId ?? process.env.CHROMA_QA_SPACE
if (spaceId != null && (!/^\d+$/.test(String(spaceId)) || Number(spaceId) < 1)) {
  throw new Error('The configured task space ID must be a positive integer.')
}
const ownsSpace = !spaceId
const task = await taskSpace(spaceId ? Number(spaceId) : 'CHROMA landing button contrast')
const page = task.page('p1')
const measurements = []
let original

// Theme and hover changes may start CSS transitions. Flush a frame first, then
// wait for finite animations so an intermediate color cannot pass the check.
async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  undefined, { timeout: 5_000 })
}

function measure({ theme, viewport, state, index }) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = color => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const values = context.getImageData(0, 0, 1, 1).data
    return [values[0], values[1], values[2], values[3] / 255]
  }
  const over = (foreground, background) => foreground.slice(0, 3)
    .map((channel, i) => channel * foreground[3] + background[i] * (1 - foreground[3]))
  const luminance = rgb => {
    const linear = rgb.map(channel => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  return [...document.querySelectorAll('.landing .btn-primary')].flatMap((button, buttonIndex) => {
    if (index != null && index !== buttonIndex) return []
    const style = getComputedStyle(button)
    const rect = button.getBoundingClientRect()
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return []
    const ancestors = []
    for (let node = button.parentElement; node; node = node.parentElement) ancestors.unshift(node)
    let surface = [255, 255, 255]
    for (const node of ancestors) surface = over(rgba(getComputedStyle(node).backgroundColor), surface)
    const background = over(rgba(style.backgroundColor), surface)
    const foreground = over(rgba(style.color), background)
    const opacity = Number(style.opacity)
    const visibleBackground = over([...background, opacity], surface)
    const visibleForeground = over([...foreground, opacity], surface)
    const values = [luminance(visibleForeground), luminance(visibleBackground)].sort((a, b) => b - a)
    const contrast = (values[0] + 0.05) / (values[1] + 0.05)
    return [{ theme, viewport, state, index: buttonIndex,
      label: button.textContent.replace(/\s+/g, ' ').trim(),
      color: style.color, background: style.backgroundColor, backgroundImage: style.backgroundImage,
      disabled: button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true',
      contrast, hovered: button.matches(':hover') }]
  })
}

try {
  console.log(JSON.stringify({ taskSpaceId: task.spaceId, page: page.label }))
  await page.goto(config.url ?? process.env.CHROMA_QA_URL ?? 'http://localhost:5173/')
  await page.waitForFunction(() => !!document.querySelector('.landing .btn-primary'),
    undefined, { timeout: 10_000 })
  original = await page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'),
    width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }))
  for (const viewport of [{ name: 'desktop', width: 1788, height: 942 },
    { name: 'mobile', width: 390, height: 844 }]) {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.name === 'mobile' })
    for (const theme of ['light', 'dark', 'gray']) {
      await page.mouse.move(0, 0)
      await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
      await settle()
      const normal = await page.evaluate(measure, { theme, viewport: viewport.name, state: 'normal' })
      if (!normal.length) throw new Error(`No visible landing primary buttons for ${theme}/${viewport.name}.`)
      measurements.push(...normal)
      for (const { index } of normal) {
        console.log(JSON.stringify({ checking: { theme, viewport: viewport.name, index } }))
        await page.evaluate(buttonIndex => {
          document.querySelectorAll('.landing .btn-primary')[buttonIndex]
            .scrollIntoView({ block: 'center', behavior: 'instant' })
        }, index)
        await settle()
        await page.hover(`loc=css:.landing .btn-primary >> nth=${index}`)
        await settle()
        const hovered = await page.evaluate(measure, { theme, viewport: viewport.name, state: 'hover', index })
        if (hovered.length !== 1 || !hovered[0].hovered) throw new Error(`Hover did not reach landing button ${index}.`)
        measurements.push(...hovered)
      }
    }
  }
  const enabled = measurements.filter(item => !item.disabled)
  if (!enabled.length) throw new Error('No enabled landing primary button was checked.')
  const failures = enabled.filter(item =>
    (item.contrast < 4.5 || item.backgroundImage !== 'none' || !item.label))
  console.log(JSON.stringify({ passed: failures.length === 0, minimumEnabledContrast: Number(Math.min(
    ...enabled.map(item => item.contrast)).toFixed(2)),
    measurements: measurements.map(item => ({ ...item, contrast: Number(item.contrast.toFixed(2)) })),
    failures }, null, 2))
  if (failures.length) throw new Error(`${failures.length} landing primary button states failed the rendered contrast check.`)
} finally {
  try {
    await page.mouse.move(0, 0)
    if (original) {
      await page.evaluate(({ theme, x, y }) => {
        if (theme == null) document.documentElement.removeAttribute('data-theme')
        else document.documentElement.dataset.theme = theme
        window.scrollTo(x, y)
      }, original)
      await page.cdp('Emulation.setDeviceMetricsOverride', { width: original.width, height: original.height,
        deviceScaleFactor: 1, mobile: false })
    }
  } finally {
    if (ownsSpace) await task.finish({ keep: [] })
  }
}
