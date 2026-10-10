const clamp01 = (value) => Math.max(0, Math.min(1, value))

export function displayComponent(value, inputStyle = 'STD') {
  const encoded = clamp01(value)
  if (inputStyle !== 'VLOG') return encoded
  const linear = encoded <= 0.081 ? encoded / 4.5 : ((encoded + 0.099) / 1.099) ** (1 / 0.45)
  return clamp01(linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055)
}

export function displayImageData(imageData, inputStyle = 'STD') {
  if (inputStyle !== 'VLOG') return imageData
  for (let offset = 0; offset < imageData.data.length; offset += 4)
    for (let channel = 0; channel < 3; channel++)
      imageData.data[offset + channel] = Math.round(displayComponent(imageData.data[offset + channel] / 255, inputStyle) * 255)
  return imageData
}
