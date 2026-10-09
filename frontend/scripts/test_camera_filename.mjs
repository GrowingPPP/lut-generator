import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cameraFileName } from '../src/lib/api.js'
import { paramsToCube, defaultParams } from '../src/lib/lutEngine.js'

test('机内文件名是稳定的 8 位 ASCII，适合 FAT32 导入', () => {
  const name = cameraFileName('日系清透')
  assert.match(name, /^[0-9A-F]{8}\.cube$/)
  assert.equal(name, cameraFileName('日系清透'))
  assert.notEqual(name, cameraFileName('电影青橙'))
})

test('切换基准后导出以当前参数为准', () => {
  const params = { ...defaultParams(), base_photo_style: 'VIVD', temp: 300 }
  const cube = paramsToCube(params, { title: '现在的风格', mode: 'camera', size: 5 })
  assert.match(cube, /#LUMIXPHOTOSTYLE VIVD/)
  assert.match(cube, /LUT_3D_SIZE 5/)
})
