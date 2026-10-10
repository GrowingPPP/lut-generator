import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultParams } from '../src/lib/lutEngine.js'
import { PARAM_GROUPS } from '../src/lib/parameterControls.js'
import { PARAMETER_HELP, PARAMETER_GROUP_HELP, BEGINNER_GUIDE } from '../src/lib/parameterHelp.js'

test('每个可调参数都有完整的创作说明，不遗留无对应参数的说明', () => {
  assert.deepEqual(Object.keys(PARAMETER_HELP).sort(), Object.keys(defaultParams()).sort())
  for (const [key, help] of Object.entries(PARAMETER_HELP)) {
    for (const field of ['title', 'summary', 'decrease', 'increase', 'tryThis', 'note']) {
      assert.equal(typeof help[field], 'string', `${key} 缺少 ${field}`)
      assert.ok(help[field].trim().length > 0, `${key} 的 ${field} 为空`)
    }
  }
})

test('每个参数组与独立自由曲线都有用途和入手建议', () => {
  const groupIds = [...PARAM_GROUPS.map(group => group.id), 'curves'].sort()
  assert.deepEqual(Object.keys(PARAMETER_GROUP_HELP).sort(), groupIds)
  for (const [key, help] of Object.entries(PARAMETER_GROUP_HELP)) {
    for (const field of ['summary', 'startWith']) {
      assert.equal(typeof help[field], 'string', `${key} 缺少 ${field}`)
      assert.ok(help[field].trim().length > 0, `${key} 的 ${field} 为空`)
    }
  }
})

test('入门指南只提供阅读建议，阅读不会自动调整照片', () => {
  assert.ok(BEGINNER_GUIDE.length >= 4 && BEGINNER_GUIDE.length <= 5)
  for (const entry of BEGINNER_GUIDE) {
    assert.deepEqual(Object.keys(entry).sort(), ['body', 'title'])
    assert.equal(typeof entry.title, 'string')
    assert.ok(entry.title.trim().length > 0)
    assert.equal(typeof entry.body, 'string')
    assert.ok(entry.body.trim().length > 0)
  }
})
