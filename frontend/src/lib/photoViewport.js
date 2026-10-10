export const MIN_PHOTO_ZOOM = 0.25
export const MAX_PHOTO_ZOOM = 4

export function fitPhotoScale(image, frame) {
  if (!image?.width || !image?.height || !frame?.width || !frame?.height) return 1
  return Math.min(frame.width / image.width, frame.height / image.height, MAX_PHOTO_ZOOM)
}

export function clampPhotoPan(view, image, frame) {
  const xLimit = Math.max(0, (image.width * view.scale - frame.width) / 2)
  const yLimit = Math.max(0, (image.height * view.scale - frame.height) / 2)
  return {
    ...view,
    x: Math.max(-xLimit, Math.min(xLimit, view.x)),
    y: Math.max(-yLimit, Math.min(yLimit, view.y)),
  }
}

export function zoomPhotoAt(view, scale, anchor, image, frame) {
  if (view.scale <= MIN_PHOTO_ZOOM && scale <= view.scale) return view
  const nextScale = Math.max(MIN_PHOTO_ZOOM, Math.min(MAX_PHOTO_ZOOM, scale))
  const ratio = nextScale / view.scale
  return clampPhotoPan({
    scale: nextScale,
    x: anchor.x - frame.width / 2 - (anchor.x - frame.width / 2 - view.x) * ratio,
    y: anchor.y - frame.height / 2 - (anchor.y - frame.height / 2 - view.y) * ratio,
    fit: false,
  }, image, frame)
}

export function photoFramePoint(point, stage, paired = false) {
  const x = point.x - stage.left
  const width = paired ? (stage.width - 1) / 2 : stage.width
  return {
    x: paired && x > width ? x - width - 1 : x,
    y: point.y - stage.top,
  }
}

export function photoTransform(view, image, frame) {
  return `translate(${(frame.width - image.width * view.scale) / 2 + view.x}px, ${(frame.height - image.height * view.scale) / 2 + view.y}px) scale(${view.scale})`
}

export function photoViewerMode(mode, narrow = false) {
  const normalized = mode === 'split' ? 'side-by-side' : mode
  if (normalized === 'side-by-side' && narrow) return 'slider'
  return ['slider', 'side-by-side', 'original', 'effect'].includes(normalized) ? normalized : 'slider'
}
