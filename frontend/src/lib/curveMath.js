export const CURVE_CHANNELS = Object.freeze(['master', 'r', 'g', 'b'])
export const MAX_CURVE_POINTS = 16
export const MIN_POINT_DISTANCE = 0.0001
export const identityCurves = () => Object.fromEntries(CURVE_CHANNELS.map(channel => [channel, [[0, 0], [1, 1]]]))
export function validateCurvePoints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || CURVE_CHANNELS.some(key => !Object.hasOwn(value, key))) throw new Error('曲线必须包含 master、r、g、b 四个通道')
  const result = {}
  for (const channel of CURVE_CHANNELS) {
    const points = value[channel]
    if (!Array.isArray(points) || points.length < 2 || points.length > MAX_CURVE_POINTS) throw new Error('每条曲线需要 2–16 个控制点')
    if (points.some(point => !Array.isArray(point) || point.length !== 2 || point.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1))) throw new Error('控制点需为 0–1 的有限数字 [输入,输出]')
    if (points[0][0] !== 0 || points.at(-1)[0] !== 1) throw new Error('曲线输入端点必须为 0 和 1')
    for (let i = 1; i < points.length; i++) if (points[i][0] - points[i - 1][0] < MIN_POINT_DISTANCE || points[i][1] < points[i - 1][1]) throw new Error('曲线输入需严格递增且至少间隔 0.0001,输出不能下降')
    result[channel] = points.map(point => [...point])
  }
  return result
}
export function curveSlopes(points) {
  const n = points.length, h = [], delta = [], slopes = new Array(n).fill(0)
  for (let i = 0; i < n - 1; i++) { h.push(points[i + 1][0] - points[i][0]); delta.push((points[i + 1][1] - points[i][1]) / h[i]) }
  if (n === 2) return [delta[0], delta[0]]
  for (let i = 1; i < n - 1; i++) if (delta[i - 1] > 0 && delta[i] > 0) {
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]
    slopes[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i])
  }
  slopes[0] = Math.max(0, Math.min(3 * delta[0], ((2 * h[0] + h[1]) * delta[0] - h[0] * delta[1]) / (h[0] + h[1])))
  const end = n - 2
  slopes[n - 1] = Math.max(0, Math.min(3 * delta[end], ((2 * h[end] + h[end - 1]) * delta[end] - h[end] * delta[end - 1]) / (h[end] + h[end - 1])))
  return slopes
}
export function prepareCurve(points) {
  if (points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1) return value => Math.max(0, Math.min(1, value))
  const slopes = curveSlopes(points)
  return value => {
    const x = Math.max(0, Math.min(1, value))
    let i = 0
    while (i < points.length - 2 && x >= points[i + 1][0]) i++
    const h = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / h, t2 = t * t, t3 = t2 * t
    return Math.max(0, Math.min(1, (2 * t3 - 3 * t2 + 1) * points[i][1] + (t3 - 2 * t2 + t) * h * slopes[i] + (-2 * t3 + 3 * t2) * points[i + 1][1] + (t3 - t2) * h * slopes[i + 1]))
  }
}
export function prepareFreeCurves(points) {
  const master = prepareCurve(points.master), channels = ['r', 'g', 'b'].map(channel => prepareCurve(points[channel]))
  return (r, g, b) => [r, g, b].map((value, index) => channels[index](master(value)))
}
