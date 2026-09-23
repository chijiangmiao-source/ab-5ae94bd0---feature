import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { solve } from '../src/solver.js'

// 在 jsdom 中引导真实的 src/main.js，用“真实求解器驱动”的 Worker 替身。
function boot() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const { window } = dom
  const g = globalThis
  g.window = window
  g.document = window.document
  g.navigator = window.navigator
  g.HTMLElement = window.HTMLElement
  g.Event = window.Event
  g.MouseEvent = window.MouseEvent

  // Worker 替身：与 src/worker.js 相同的序列化，同步回传真实求解结果
  class FakeWorker {
    constructor() { this.onmessage = null; this.onerror = null }
    postMessage(msg) {
      const { id, input } = msg
      let payload
      try {
        const result = solve(input)
        payload = {
          id,
          ok: true,
          result: {
            ...result,
            ...(result.optimumCost !== undefined
              ? { optimumCost: result.optimumCost.toString(), optimumCount: result.optimumCount.toString() }
              : {}),
          },
        }
      } catch (e) {
        payload = { id, ok: false, message: String(e.message || e) }
      }
      this.onmessage({ data: payload })
    }
  }
  g.Worker = FakeWorker
  return dom
}

function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true }))
}

let dom
test.before(async () => {
  dom = boot()
  await import('../src/main.js')
})

test('UI 端到端：示例求解→计数/规范矩阵/可变标记/克隆树；编辑后旧结果立即失效；非法输入保留草稿', () => {
  const $ = (id) => document.getElementById(id)

  // —— 1. 载入歧义示例并求解 ——
  $('loadSample').click()
  // 问号数应为 4
  assert.equal($('unkCount').textContent, '4')
  $('solveBtn').click()

  // 结果区出现，指标正确（字符串形式，任意精度）
  assert.equal($('resultSection').classList.contains('hidden'), false)
  assert.equal($('optCost').textContent, '8')
  assert.equal($('optCount').textContent, '3')

  // 规范矩阵中的问号格裁决类
  const cell = (r, c) => [...$('resultMatrix').querySelectorAll('tr')][r + 1].children[c + 1]
  assert.ok(cell(0, 2).classList.contains('free'))
  assert.ok(cell(2, 2).classList.contains('free'))
  assert.ok(cell(1, 0).classList.contains('fixed1'))
  assert.ok(cell(3, 1).classList.contains('fixed0'))

  // 克隆树至少渲染根节点与若干子节点
  assert.ok($('tree').querySelectorAll('.treenode').length >= 2)
  // JSON 可复算记录包含输入与结果
  const dump = JSON.parse($('jsonDump').textContent)
  assert.equal(dump.result.optimumCount, '3')
  assert.equal(dump.input.matrix[0][2], -1)

  // —— 2. 改动一个固定值后，旧结果必须立即失效（不得用旧结果冒充） ——
  const firstSelect = $('grid').querySelectorAll('select.cell')[0]
  firstSelect.value = '1'
  fire(firstSelect, 'change')
  assert.equal($('resultSection').classList.contains('hidden'), true)

  // —— 3. 非法规模：保留草稿，不重建为错误规模 ——
  const rowsBefore = $('grid').querySelectorAll('tr').length
  $('nRows').value = '99'
  $('applySize').click()
  assert.equal($('errorBox').classList.contains('hidden'), false)
  assert.match($('errorBox').textContent, /4.*18|规模非法/)
  assert.equal($('grid').querySelectorAll('tr').length, rowsBefore, '草稿行未被破坏')
  $('nRows').value = '6'

  // —— 4. 冲突示例：展示突变对与三项见证 ——
  $('loadConflict').click()
  $('solveBtn').click()
  assert.equal($('resultSection').classList.contains('hidden'), true)
  assert.equal($('conflictBox').classList.contains('hidden'), false)
  const ctext = $('conflictBox').textContent
  assert.match(ctext, /M1\s*×\s*M2/)
  assert.match(ctext, /11 见证 C1/)
  assert.match(ctext, /10 见证 C2/)
  assert.match(ctext, /01 见证 C3/)

  // —— 5. 非法代价：拦截且不产生结果，草稿保留 ——
  $('loadSample').click()
  const costInput = document.querySelector('input.cost')
  costInput.value = 'abc'
  fire(costInput, 'input')
  $('solveBtn').click()
  assert.equal($('errorBox').classList.contains('hidden'), false)
  assert.match($('errorBox').textContent, /非负整数/)
  assert.equal($('resultSection').classList.contains('hidden'), true)
})
