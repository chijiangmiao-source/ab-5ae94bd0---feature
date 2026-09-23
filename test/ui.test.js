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

test('UI 负荷约束：开关、负荷示例（代价 15、负荷表）、输入冲突保留草稿', () => {
  const $ = (id) => document.getElementById(id)

  // —— 1. 负荷示例：代价由 8 升至 15，负荷结果表出现 ——
  $('loadLoads').click()
  assert.equal($('loadsEnabled').checked, true)
  assert.equal($('loadsEditorWrap').classList.contains('hidden'), false)
  // 区间编辑器有 4 行（表头 + 4 细胞）
  assert.equal($('loadsTable').querySelectorAll('tr').length, 4 + 1)
  $('solveBtn').click()
  assert.equal($('resultSection').classList.contains('hidden'), false)
  assert.equal($('optCost').textContent, '15')
  assert.equal($('optCount').textContent, '3')
  // 负荷结果表显示，4 行，且 C4 最终负荷=1、距下限余量0
  assert.equal($('loadsResultWrap').classList.contains('hidden'), false)
  const loadRows = [...$('loadsResult').querySelectorAll('tr')]
  assert.equal(loadRows.length, 4 + 1)
  const c4 = loadRows[4].children
  assert.equal(c4[0].textContent, 'C4')
  assert.equal(c4[1].textContent, '[1, 3]')
  assert.equal(c4[2].textContent, '1')
  assert.equal(c4[3].textContent, '0')
  // (3,1) 现为固定 1
  const cell = (r, c) => [...$('resultMatrix').querySelectorAll('tr')][r + 1].children[c + 1]
  assert.ok(cell(3, 1).classList.contains('fixed1'))
  // JSON 记录包含 loads 输入与结果
  const dump = JSON.parse($('jsonDump').textContent)
  assert.equal(dump.input.loads.enabled, true)
  assert.equal(dump.input.loads.ranges[3].lo, 1)
  assert.equal(dump.result.loads[3].final, 1)

  // —— 2. 关闭开关后：区间编辑器隐藏，输入不再带 loads，代价回到 8 ——
  $('loadsEnabled').checked = false
  fire($('loadsEnabled'), 'change')
  assert.equal($('loadsEditorWrap').classList.contains('hidden'), true)
  assert.equal($('resultSection').classList.contains('hidden'), true, '切换开关立即失效旧结果')
  $('solveBtn').click()
  assert.equal($('optCost').textContent, '8')
  assert.equal($('loadsResultWrap').classList.contains('hidden'), true)
  const dump2 = JSON.parse($('jsonDump').textContent)
  assert.equal(dump2.input.loads, undefined)

  // —— 3. 负荷输入冲突（固定1超上限）：conflictBox 展示输入冲突，结果区隐藏 ——
  $('loadLoads').click()
  // 改为无问号、固定每行负荷明确的层状矩阵：C1=3 个1
  // 直接改首行三个单元格为 1 并清掉问号不现实，转而构造 C4 下限超高（under）：
  // 负荷示例中 C4 只有 1 个问号 (3,1)，固定1=0，把其下限设为 3 → 达不到
  const c4lo = document.querySelector('input.loadbound[data-r="3"][data-which="lo"]')
  c4lo.value = '3'
  fire(c4lo, 'input')
  $('solveBtn').click()
  assert.equal($('resultSection').classList.contains('hidden'), true)
  assert.equal($('conflictBox').classList.contains('hidden'), false)
  assert.match($('conflictBox').textContent, /C4/)
  assert.match($('conflictBox').textContent, /达不到下限/)
  // 草稿保留：区间输入仍是 3
  assert.equal(c4lo.value, '3')

  // —— 4. 非法区间（lo>hi）：错误提示，不产生结果 ——
  const c1lo = document.querySelector('input.loadbound[data-r="0"][data-which="lo"]')
  c1lo.value = '9'
  fire(c1lo, 'input')
  $('solveBtn').click()
  assert.equal($('errorBox').classList.contains('hidden'), false)
  assert.match($('errorBox').textContent, /上限|下限/)
  assert.equal($('resultSection').classList.contains('hidden'), true)
})
