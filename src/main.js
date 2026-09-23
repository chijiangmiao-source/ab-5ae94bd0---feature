// 页面状态与 Worker 编排。关键不变量：
//  - 代价按“单元格键”保存，提交求解时严格按行优先顺序序列化，自动与求解器对齐；
//  - 任何编辑都会立即隐藏旧结果（绝不用旧结果冒充新输入的答案）；
//  - 规模/格式错误只提示，不破坏当前草稿。

const $ = (id) => document.getElementById(id)

const state = {
  n: 6,
  m: 4,
  // 单元格值：0 / 1 / '?'；代价按 `${r},${c}` 保存为字符串（任意位数）
  cells: new Map(),
  costs: new Map(),
  // 逐细胞负荷区间：`${r}` -> { lo, hi }（字符串，任意位数）
  loadEnabled: false,
  loads: new Map(),
  result: null,
  lastInput: null,
  reqId: 0,
}

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
worker.onmessage = (e) => {
  const { id, ok, result, message } = e.data || {}
  if (id !== state.reqId) return // 过期响应（理论上每次重建 Worker，双保险）
  setBusy(false)
  if (!ok) {
    showError('Worker 内部错误：' + message)
    return
  }
  state.result = result
  renderResult(result, state.lastInput)
}
worker.onerror = (e) => {
  setBusy(false)
  showError('Worker 加载或运行失败：' + (e.message || e.type))
}

// —— 矩阵网格 ——
function defaultVal(r, c) {
  if (state.cells.has(`${r},${c}`)) return state.cells.get(`${r},${c}`)
  return '0'
}

function buildGrid() {
  const table = $('grid')
  table.innerHTML = ''
  const thead = document.createElement('tr')
  const corner = document.createElement('th')
  corner.textContent = '细胞 \\ 突变'
  thead.appendChild(corner)
  for (let c = 0; c < state.m; c++) {
    const th = document.createElement('th')
    th.textContent = `M${c + 1}`
    thead.appendChild(th)
  }
  table.appendChild(thead)

  for (let r = 0; r < state.n; r++) {
    const tr = document.createElement('tr')
    const rh = document.createElement('th')
    rh.textContent = `C${r + 1}`
    tr.appendChild(rh)
    for (let c = 0; c < state.m; c++) {
      const td = document.createElement('td')
      const sel = document.createElement('select')
      sel.dataset.r = r
      sel.dataset.c = c
      for (const v of ['0', '1', '?']) {
        const opt = document.createElement('option')
        opt.value = v
        opt.textContent = v === '?' ? '?' : v
        sel.appendChild(opt)
      }
      sel.value = String(defaultVal(r, c))
      sel.classList.add('cell', `v${sel.value === '?' ? 'q' : sel.value}`)
      sel.addEventListener('change', onCellChange)
      td.appendChild(sel)
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }
  refreshCostEditor()
  refreshLoadEditor()
}

function onCellChange(e) {
  const r = Number(e.target.dataset.r)
  const c = Number(e.target.dataset.c)
  state.cells.set(`${r},${c}`, e.target.value)
  e.target.classList.remove('v0', 'v1', 'vq')
  e.target.classList.add(`v${e.target.value === '?' ? 'q' : e.target.value}`)
  invalidateResults()
  refreshCostEditor()
  refreshLoadEditor()
}

// —— 问号代价编辑器（顺序即行优先） ——
function unknownList() {
  const list = []
  for (let r = 0; r < state.n; r++)
    for (let c = 0; c < state.m; c++)
      if (defaultVal(r, c) === '?') list.push({ r, c })
  return list
}

function refreshCostEditor() {
  // 代价输入框直接嵌在矩阵下方独立表中；重建时保留既有值
  const wrap = $('costTableWrap')
  const unk = unknownList()
  $('unkCount').textContent = String(unk.length)
  if (!wrap) return
  if (unk.length === 0) {
    wrap.innerHTML = '<p class="muted">当前没有问号；把单元格改为 “?” 后可设置代价。</p>'
    return
  }
  const table = document.createElement('table')
  table.className = 'costs'
  const thead = document.createElement('tr')
  for (const h of ['#', '细胞', '突变', '填 0 代价', '填 1 代价']) {
    const th = document.createElement('th'); th.textContent = h; thead.appendChild(th)
  }
  table.appendChild(thead)
  unk.forEach(({ r, c }, i) => {
    const key = `${r},${c}`
    const cur = state.costs.get(key) ?? { c0: '0', c1: '0' }
    const tr = document.createElement('tr')
    const mk = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td }
    tr.appendChild(mk(String(i + 1)))
    tr.appendChild(mk(`C${r + 1}`))
    tr.appendChild(mk(`M${c + 1}`)
    )
    for (const which of ['c0', 'c1']) {
      const td = document.createElement('td')
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.inputMode = 'numeric'
      inp.pattern = '[0-9]*'
      inp.value = cur[which]
      inp.className = 'cost'
      inp.dataset.r = r
      inp.dataset.c = c
      inp.dataset.which = which
      inp.addEventListener('input', onCostChange)
      td.appendChild(inp)
      tr.appendChild(td)
    }
    table.appendChild(tr)
  })
  wrap.innerHTML = ''
  wrap.appendChild(table)
}

function onCostChange(e) {
  const r = Number(e.target.dataset.r)
  const c = Number(e.target.dataset.c)
  const which = e.target.dataset.which
  const key = `${r},${c}`
  const cur = state.costs.get(key) ?? { c0: '0', c1: '0' }
  cur[which] = e.target.value
  state.costs.set(key, cur)
  invalidateResults()
}

// —— 逐细胞负荷区间编辑器（启用时显示） ——
function refreshLoadEditor() {
  const wrap = $('loadTableWrap')
  if (!state.loadEnabled) {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden')
  // 已有同名表则原地重建（保留既有输入值）
  let table = wrap.querySelector('table.loads')
  if (table) table.remove()
  table = document.createElement('table')
  table.className = 'costs'
  const thead = document.createElement('tr')
  for (const h of ['细胞', '固定 1 数', '问号数', '负荷下限 lo', '负荷上限 hi']) {
    const th = document.createElement('th'); th.textContent = h; thead.appendChild(th)
  }
  table.appendChild(thead)
  for (let r = 0; r < state.n; r++) {
    let fx = 0, q = 0
    for (let c = 0; c < state.m; c++) {
      const v = defaultVal(r, c)
      if (v === '1') fx++
      else if (v === '?') q++
    }
    const cur = state.loads.get(`${r}`) ?? { lo: String(fx), hi: String(fx + q) }
    const tr = document.createElement('tr')
    const mk = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td }
    tr.appendChild(mk(`C${r + 1}`))
    tr.appendChild(mk(String(fx)))
    tr.appendChild(mk(String(q)))
    for (const which of ['lo', 'hi']) {
      const td = document.createElement('td')
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.inputMode = 'numeric'
      inp.pattern = '[0-9]*'
      inp.value = cur[which]
      inp.className = 'cost load'
      inp.dataset.r = r
      inp.dataset.which = which
      inp.addEventListener('input', onLoadChange)
      td.appendChild(inp)
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }
  wrap.appendChild(table)
}

function onLoadChange(e) {
  const r = Number(e.target.dataset.r)
  const which = e.target.dataset.which
  const cur = state.loads.get(`${r}`) ?? { lo: '0', hi: '0' }
  cur[which] = e.target.value
  state.loads.set(`${r}`, cur)
  invalidateResults()
}

// —— 规模应用（错误时保留草稿） ——
function applySize() {
  const n = Number($('nRows').value)
  const m = Number($('nCols').value)
  if (!Number.isInteger(n) || n < 4 || n > 18 || !Number.isInteger(m) || m < 3 || m > 12) {
    showError(`规模非法：细胞数须为 4–18、突变数须为 3–12（当前 ${n} × ${m}）。草稿已保留。`)
    return
  }
  state.n = n
  state.m = m
  // 清理越界键
  for (const key of [...state.cells.keys()]) {
    const [r, c] = key.split(',').map(Number)
    if (r >= n || c >= m) state.cells.delete(key)
  }
  for (const key of [...state.costs.keys()]) {
    const [r, c] = key.split(',').map(Number)
    if (r >= n || c >= m) state.costs.delete(key)
  }
  for (const key of [...state.loads.keys()]) {
    if (Number(key) >= n) state.loads.delete(key)
  }
  clearAlerts()
  invalidateResults()
  buildGrid()
}

// —— 序列化输入 ——
function collectInput() {
  const matrix = []
  for (let r = 0; r < state.n; r++) {
    const row = []
    for (let c = 0; c < state.m; c++) {
      const v = defaultVal(r, c)
      row.push(v === '?' ? -1 : Number(v))
    }
    matrix.push(row)
  }
  const costs = []
  for (let r = 0; r < state.n; r++) {
    for (let c = 0; c < state.m; c++) {
      if (matrix[r][c] === -1) {
        const cur = state.costs.get(`${r},${c}`) ?? { c0: '0', c1: '0' }
        costs.push({ c0: cur.c0.trim(), c1: cur.c1.trim() })
      }
    }
  }
  const input = { matrix, costs, loadEnabled: state.loadEnabled }
  if (state.loadEnabled) {
    input.loads = []
    for (let r = 0; r < state.n; r++) {
      let fx = 0, q = 0
      for (let c = 0; c < state.m; c++) {
        if (matrix[r][c] === 1) fx++
        else if (matrix[r][c] === -1) q++
      }
      const cur = state.loads.get(`${r}`) ?? { lo: String(fx), hi: String(fx + q) }
      input.loads.push({ lo: cur.lo.trim(), hi: cur.hi.trim() })
    }
  }
  return input
}

function validateCostsLocally(input) {
  for (let i = 0; i < input.costs.length; i++) {
    for (const which of ['c0', 'c1']) {
      const v = input.costs[i][which]
      if (!/^\d+$/.test(String(v))) {
        return `第 ${i + 1} 个问号的“${which === 'c0' ? '填 0' : '填 1'}代价”不是非负整数：${JSON.stringify(v)}`
      }
    }
  }
  if (input.loadEnabled) {
    for (let r = 0; r < input.matrix.length; r++) {
      const { lo, hi } = input.loads[r]
      if (!/^\d+$/.test(String(lo)) || !/^\d+$/.test(String(hi))) {
        return `细胞 C${r + 1} 的负荷区间不是非负整数：${JSON.stringify([lo, hi])}`
      }
      if (BigInt(lo) > BigInt(hi)) return `细胞 C${r + 1} 的负荷下限（${lo}）大于上限（${hi}）`
    }
  }
  return null
}

// —— 求解 ——
function runSolve() {
  clearAlerts()
  const input = collectInput()
  const localErr = validateCostsLocally(input)
  if (input.matrix.flat().filter((v) => v === -1).length > 28) {
    invalidateResults()
    showError('未知格总数超过 28，请减少问号。草稿已保留。')
    return
  }
  if (localErr) {
    invalidateResults()
    showError(localErr + '。草稿已保留。')
    return
  }
  state.lastInput = input
  state.reqId++
  setBusy(true)
  worker.postMessage({ id: state.reqId, input })
}

function setBusy(b) {
  $('solveBtn').disabled = b
  $('workerStatus').textContent = b ? 'Worker 计算中…' : ''
}

function invalidateResults() {
  state.result = null
  $('resultSection').classList.add('hidden')
  $('copyStatus').textContent = ''
}

// —— 结果渲染 ——
function renderResult(res, input) {
  if (res.status === 'conflict') {
    renderConflict(res)
    return
  }
  if (res.status === 'infeasible') {
    $('conflictBox').classList.add('hidden')
    $('infeasibleBox').classList.remove('hidden')
    $('infeasibleBox').innerHTML = input.loadEnabled
      ? '<b>不存在可行补全。</b>固定数据没有直接的输入冲突（三配型或负荷越界），' +
        '但全部细胞的负荷区间与无限位点约束联合起来无解：各列分量各自可行，' +
        '组合后找不到同时满足所有闭区间的补全。请放宽某些细胞的区间，或调整固定值/问号位置。'
      : '<b>不存在可行补全。</b>固定数据本身没有直接的三配型冲突，但无论怎样补全问号，' +
        '都无法使全部突变两两满足无限位点。请调整固定值或问号位置。'
    $('resultSection').classList.add('hidden')
    return
  }
  if (res.status === 'error') {
    showError(res.message)
    return
  }
  $('infeasibleBox').classList.add('hidden')
  $('conflictBox').classList.add('hidden')

  $('optCost').textContent = res.optimumCost
  $('optCount').textContent = res.optimumCount

  const callMap = new Map(res.calls.map((x) => [`${x.r},${x.c}`, x.kind]))
  const table = $('resultMatrix')
  table.innerHTML = ''
  const thead = document.createElement('tr')
  const corner = document.createElement('th'); corner.textContent = '细胞 \\ 突变'; thead.appendChild(corner)
  for (let c = 0; c < state.m; c++) {
    const th = document.createElement('th'); th.textContent = `M${c + 1}`; thead.appendChild(th)
  }
  table.appendChild(thead)
  for (let r = 0; r < state.n; r++) {
    const tr = document.createElement('tr')
    const rh = document.createElement('th'); rh.textContent = `C${r + 1}`; tr.appendChild(rh)
    for (let c = 0; c < state.m; c++) {
      const td = document.createElement('td')
      const v = res.matrix[r][c]
      td.textContent = v
      const isUnknown = input.matrix[r][c] === -1
      if (isUnknown) td.classList.add('unk', callMap.get(`${r},${c}`))
      else td.classList.add('fixedcell')
      td.title = isUnknown
        ? { fixed0: '固定 0：所有最优补全中均为 0', fixed1: '固定 1：所有最优补全中均为 1', free: '同优可变：取 0 或 1 都能达到最优' }[callMap.get(`${r},${c}`)]
        : '固定观测值'
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }

  renderTree(res.cloneTree)
  renderLoadReport(res, input)
  $('jsonDump').textContent = JSON.stringify({ input, result: res }, null, 2)
  $('resultSection').classList.remove('hidden')
}

function renderLoadReport(res, input) {
  const wrap = $('loadReportWrap')
  if (!input.loadEnabled || !res.loadReport) {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden')
  const table = $('loadReportTable')
  table.innerHTML = ''
  const thead = document.createElement('tr')
  for (const h of ['细胞', '最终负荷', '区间', '区间余量（上限 − 最终负荷）']) {
    const th = document.createElement('th'); th.textContent = h; thead.appendChild(th)
  }
  table.appendChild(thead)
  for (const e of res.loadReport) {
    const tr = document.createElement('tr')
    const mk = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td }
    tr.appendChild(mk(`C${e.row + 1}`))
    tr.appendChild(mk(String(e.load)))
    tr.appendChild(mk(`[${e.lo}, ${e.hi}]`))
    tr.appendChild(mk(String(e.slack)))
    table.appendChild(tr)
  }
}

function renderConflict(res) {
  $('resultSection').classList.add('hidden')
  const box = $('conflictBox')
  box.classList.remove('hidden')
  const parts = []
  if (res.loadConflicts && res.loadConflicts.length) {
    parts.push('<b>逐细胞负荷输入冲突：</b>无需搜索即可判定以下细胞的区间无法满足，' +
      '草稿已保留，且不会展示旧结果。<ul class="conflict-list">')
    for (const lc of res.loadConflicts) {
      if (lc.reason === 'over') {
        parts.push(`<li><b>C${lc.row + 1}</b>：固定 1 已达 <b>${lc.fixed}</b>，` +
          `超过负荷上限 ${lc.hi}（区间 [${lc.lo}, ${lc.hi}]）。</li>`)
      } else {
        parts.push(`<li><b>C${lc.row + 1}</b>：固定 1 为 ${lc.fixed}、问号仅 ${lc.unknown} 个，` +
          `即使全部填 1 也只有 ${lc.fixed + lc.unknown}，达不到下限 ${lc.lo}` +
          `（区间 [${lc.lo}, ${lc.hi}]）。</li>`)
      }
    }
    parts.push('</ul>')
  }
  if (res.conflicts && res.conflicts.length) {
    parts.push('<b>固定数据已形成三配型冲突，</b>无需补全即可判定不满足无限位点。涉及突变对与三项细胞见证：<ul class="conflict-list">')
    for (const cf of res.conflicts) {
      const fmt = (rows) => rows.map((r) => `C${r + 1}`).join('、')
      parts.push(
        `<li><b>M${cf.a + 1} × M${cf.b + 1}</b>：` +
        `11 见证 ${fmt(cf.p11)}；` +
        `10 见证 ${fmt(cf.p10)}；` +
        `01 见证 ${fmt(cf.p01)}。</li>`)
    }
    parts.push('</ul>')
  }
  box.innerHTML = parts.join('')
}

function renderTree(tree) {
  const root = $('tree')
  root.innerHTML = ''
  const absent = tree.absentMutations || []
  $('absentNote').classList.toggle('hidden', absent.length === 0)
  if (absent.length) {
    $('absentNote').textContent =
      '以下突变在规范补全中无任何载体细胞（空突变，未出现在树中）：' +
      absent.map((c) => `M${c + 1}`).join('、') + '。'
  }

  const nodeLabel = (node) => {
    const carriers = node.carriers.map((r) => `C${r + 1}`).join('、') || '∅'
    const muts = node.mutations.map((c) => `M${c + 1}`).join('、')
    return node.root
      ? `<b>根（全部细胞）</b> <span class="muted">[${carriers}]</span>`
      : `<b>${muts}</b> <span class="muted">载体：${carriers}</span>`
  }
  const build = (node) => {
    const li = document.createElement('li')
    const span = document.createElement('span')
    span.innerHTML = nodeLabel(node)
    span.className = 'treenode' + (node.root ? ' root' : '')
    li.appendChild(span)
    if (node.children.length) {
      const ul = document.createElement('ul')
      for (const ch of node.children) ul.appendChild(build(ch))
      li.appendChild(ul)
    }
    return li
  }
  const ul = document.createElement('ul')
  ul.className = 'clonetree'
  ul.appendChild(build(tree.root))
  root.appendChild(ul)
}

// —— 提示 ——
function showError(msg) {
  const box = $('errorBox')
  box.textContent = msg
  box.classList.remove('hidden')
}
function clearAlerts() {
  $('errorBox').classList.add('hidden')
  $('conflictBox').classList.add('hidden')
  $('infeasibleBox').classList.add('hidden')
}

// —— 示例与清空 ——
const SAMPLE = {
  n: 4, m: 3,
  matrix: [
    [1, 0, -1],
    [-1, 0, 0],
    [0, 1, -1],
    [0, -1, 0],
  ],
  // 行优先问号：(0,2) (1,0) (2,2) (3,1)
  costs: {
    '0,2': { c0: '5', c1: '5' },
    '1,0': { c0: '9', c1: '1' },
    '2,2': { c0: '2', c1: '2' },
    '3,1': { c0: '0', c1: '7' },
  },
}
const CONFLICT = {
  n: 4, m: 3,
  matrix: [
    [1, 1, 0],
    [1, 0, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  costs: {},
}
// 启用逐细胞负荷后的示例：区间把旧最优（全填 1、代价 0）排除，
// 迫使跨列分量联合选解（C1 最终负荷恰为 1）。
const LOADSAMPLE = {
  n: 4, m: 3,
  matrix: [
    [-1, -1, -1],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  costs: {
    '0,0': { c0: '5', c1: '0' },
    '0,1': { c0: '5', c1: '0' },
    '0,2': { c0: '5', c1: '0' },
  },
  loadEnabled: true,
  loads: {
    0: { lo: '1', hi: '1' },
    1: { lo: '0', hi: '3' },
    2: { lo: '0', hi: '3' },
    3: { lo: '0', hi: '3' },
  },
}

function loadPreset(p) {
  state.n = p.n
  state.m = p.m
  state.cells = new Map()
  for (let r = 0; r < p.n; r++)
    for (let c = 0; c < p.m; c++)
      state.cells.set(`${r},${c}`, p.matrix[r][c] === -1 ? '?' : String(p.matrix[r][c]))
  state.costs = new Map(Object.entries(p.costs).map(([k, v]) => [k, { ...v }]))
  state.loadEnabled = p.loadEnabled === true
  state.loads = p.loads
    ? new Map(Object.entries(p.loads).map(([k, v]) => [k, { ...v }]))
    : new Map()
  $('nRows').value = String(p.n)
  $('nCols').value = String(p.m)
  $('loadEnabled').checked = state.loadEnabled
  clearAlerts()
  invalidateResults()
  buildGrid()
}

// 代价表容器在初始化时插入到网格下方

// —— 事件绑定 ——
$('applySize').addEventListener('click', applySize)
$('solveBtn').addEventListener('click', runSolve)
$('loadSample').addEventListener('click', () => loadPreset(SAMPLE))
$('loadConflict').addEventListener('click', () => loadPreset(CONFLICT))
const loadLoadBtn = $('loadLoadSample')
if (loadLoadBtn) loadLoadBtn.addEventListener('click', () => loadPreset(LOADSAMPLE))
$('loadEnabled').addEventListener('change', (e) => {
  state.loadEnabled = e.target.checked
  invalidateResults()
  refreshLoadEditor()
})
$('clearAll').addEventListener('click', () => {
  state.cells = new Map()
  state.costs = new Map()
  state.loads = new Map()
  clearAlerts()
  invalidateResults()
  buildGrid()
})
$('copyJson').addEventListener('click', async () => {
  const text = $('jsonDump').textContent
  try {
    await navigator.clipboard.writeText(text)
    $('copyStatus').textContent = '已复制'
  } catch {
    $('copyStatus').textContent = '复制失败，请手动选择文本'
  }
})

// 初始化：补一个“问号代价”小节
{
  const costWrap = document.createElement('div')
  costWrap.id = 'costTableWrap'
  const h = document.createElement('h3')
  h.textContent = '问号代价（按行优先顺序）'
  const hint = $('grid').closest('.card').querySelector('.hint')
  const card = $('grid').closest('.card')
  card.insertBefore(h, hint)
  card.insertBefore(costWrap, hint)
}

buildGrid()
