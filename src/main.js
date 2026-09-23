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
  // 逐细胞负荷约束：loadsEnabled 开关 + 每行 {lo,hi} 字符串
  loadsEnabled: false,
  loadRanges: new Map(),
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
  refreshLoadsEditor()
}

function onCellChange(e) {
  const r = Number(e.target.dataset.r)
  const c = Number(e.target.dataset.c)
  state.cells.set(`${r},${c}`, e.target.value)
  e.target.classList.remove('v0', 'v1', 'vq')
  e.target.classList.add(`v${e.target.value === '?' ? 'q' : e.target.value}`)
  invalidateResults()
  refreshCostEditor()
  if (state.loadsEnabled) refreshLoadsEditor()
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

// —— 逐细胞负荷区间编辑器 ——
function defaultRange(r) {
  return state.loadRanges.get(r) ?? { lo: '0', hi: String(state.m) }
}

function refreshLoadsEditor() {
  const wrap = $('loadsEditorWrap')
  if (!wrap) return
  wrap.classList.toggle('hidden', !state.loadsEnabled)
  const table = $('loadsTable')
  table.innerHTML = ''
  const thead = document.createElement('tr')
  for (const h of ['细胞', '固定 1 数', '问号数', '下限 lo', '上限 hi']) {
    const th = document.createElement('th'); th.textContent = h; thead.appendChild(th)
  }
  table.appendChild(thead)
  for (let r = 0; r < state.n; r++) {
    let fixed = 0, q = 0
    for (let c = 0; c < state.m; c++) {
      const v = defaultVal(r, c)
      if (v === '1') fixed++
      else if (v === '?') q++
    }
    const cur = defaultRange(r)
    const tr = document.createElement('tr')
    const mk = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td }
    tr.appendChild(mk(`C${r + 1}`))
    tr.appendChild(mk(String(fixed)))
    tr.appendChild(mk(String(q)))
    for (const which of ['lo', 'hi']) {
      const td = document.createElement('td')
      const inp = document.createElement('input')
      inp.type = 'text'
      inp.inputMode = 'numeric'
      inp.pattern = '[0-9]*'
      inp.value = cur[which]
      inp.className = 'cost loadbound'
      inp.dataset.r = r
      inp.dataset.which = which
      inp.addEventListener('input', onLoadRangeChange)
      td.appendChild(inp)
      tr.appendChild(td)
    }
    table.appendChild(tr)
  }
}

function onLoadRangeChange(e) {
  const r = Number(e.target.dataset.r)
  const which = e.target.dataset.which
  const cur = defaultRange(r)
  cur[which] = e.target.value
  state.loadRanges.set(r, cur)
  invalidateResults()
}

function onLoadsEnabledChange(e) {
  state.loadsEnabled = e.target.checked
  invalidateResults()
  refreshLoadsEditor()
}

// 收集负荷区间；返回 { ok, ranges } 或 { ok:false, message }
function collectLoads() {
  if (!state.loadsEnabled) return { ok: true, enabled: false }
  const ranges = []
  for (let r = 0; r < state.n; r++) {
    const cur = defaultRange(r)
    const loTxt = String(cur.lo).trim()
    const hiTxt = String(cur.hi).trim()
    if (!/^\d+$/.test(loTxt) || !/^\d+$/.test(hiTxt)) {
      return { ok: false, message: `细胞 C${r + 1} 的负荷下限/上限必须是非负整数（当前 ${loTxt}、${hiTxt}）` }
    }
    const lo = Number(loTxt), hi = Number(hiTxt)
    if (lo > hi) {
      return { ok: false, message: `细胞 C${r + 1} 的负荷下限 ${lo} 大于上限 ${hi}` }
    }
    if (hi > state.m) {
      return { ok: false, message: `细胞 C${r + 1} 的负荷上限 ${hi} 超过突变总数 ${state.m}` }
    }
    ranges.push({ lo, hi })
  }
  return { ok: true, enabled: true, ranges }
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
  for (const key of [...state.loadRanges.keys()]) {
    if (Number(key) >= n) state.loadRanges.delete(key)
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
  const input = { matrix, costs }
  const loadData = collectLoads()
  if (loadData.enabled) input.loads = { enabled: true, ranges: loadData.ranges }
  return { input, loadData }
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
  return null
}

// —— 求解 ——
function runSolve() {
  clearAlerts()
  const { input, loadData } = collectInput()
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
  if (!loadData.ok) {
    invalidateResults()
    showError(loadData.message + '。草稿已保留。')
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
    $('loadsResultWrap').classList.add('hidden')
    $('infeasibleBox').innerHTML = input.loads
      ? '<b>不存在可行补全（全局不可行）。</b>固定数据本身没有直接冲突、每行区间也都能由该行的问号达到，' +
        '但在同时满足<b>全部细胞负荷区间</b>与无限位点约束时，各列连通分量没有任何组合可行解。' +
        '请放宽某些区间，或调整固定值 / 问号位置。'
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
  renderLoadsResult(res, input)
  $('jsonDump').textContent = JSON.stringify({ input, result: res }, null, 2)
  $('resultSection').classList.remove('hidden')
}

function renderLoadsResult(res, input) {
  const wrap = $('loadsResultWrap')
  if (!input.loads || !Array.isArray(res.loads)) { wrap.classList.add('hidden'); return }
  wrap.classList.remove('hidden')
  const table = $('loadsResult')
  table.innerHTML = ''
  const thead = document.createElement('tr')
  for (const h of ['细胞', '区间 [lo, hi]', '最终负荷', '距下限余量', '距上限余量']) {
    const th = document.createElement('th'); th.textContent = h; thead.appendChild(th)
  }
  table.appendChild(thead)
  for (const d of res.loads) {
    const tr = document.createElement('tr')
    const mk = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td }
    tr.appendChild(mk(`C${d.row + 1}`))
    tr.appendChild(mk(`[${d.lo}, ${d.hi}]`))
    const tdFinal = document.createElement('td')
    tdFinal.textContent = String(d.final)
    tdFinal.style.fontWeight = '700'
    tr.appendChild(tdFinal)
    tr.appendChild(mk(String(d.loMargin)))
    tr.appendChild(mk(String(d.hiMargin)))
    table.appendChild(tr)
  }
}

function renderConflict(res) {
  $('resultSection').classList.add('hidden')
  $('loadsResultWrap').classList.add('hidden')
  const box = $('conflictBox')
  box.classList.remove('hidden')
  const parts = []

  if (Array.isArray(res.conflicts) && res.conflicts.length) {
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

  if (Array.isArray(res.loadConflicts) && res.loadConflicts.length) {
    parts.push('<b>逐细胞负荷区间与固定数据冲突（输入冲突），</b>尚未搜索即可判定：<ul class="conflict-list">')
    for (const lc of res.loadConflicts) {
      if (lc.code === 'over') {
        parts.push(
          `<li><b>C${lc.row + 1}</b>：固定 1 已有 <b>${lc.fixed}</b> 个，已超过上限 hi=${lc.hi}（区间 [${lc.lo}, ${lc.hi}]）。</li>`)
      } else {
        parts.push(
          `<li><b>C${lc.row + 1}</b>：固定 1 有 ${lc.fixed} 个，即使该行全部问号都填 1 也只有 <b>${lc.available}</b> 个，达不到下限 lo=${lc.lo}（区间 [${lc.lo}, ${lc.hi}]）。</li>`)
      }
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

// 负荷示例：在歧义示例上要求 C4 最终至少含 1 个突变，迫使原本便宜的 (3,1) 填 1，
// 最优代价由 8 升至 15，(3,1) 由固定 0 变为固定 1。
const LOADS_SAMPLE = {
  n: 4, m: 3,
  matrix: [
    [1, 0, -1],
    [-1, 0, 0],
    [0, 1, -1],
    [0, -1, 0],
  ],
  costs: {
    '0,2': { c0: '5', c1: '5' },
    '1,0': { c0: '9', c1: '1' },
    '2,2': { c0: '2', c1: '2' },
    '3,1': { c0: '0', c1: '7' },
  },
  loadsEnabled: true,
  loadRanges: {
    0: { lo: '0', hi: '3' },
    1: { lo: '0', hi: '3' },
    2: { lo: '0', hi: '3' },
    3: { lo: '1', hi: '3' },
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
  state.loadsEnabled = !!p.loadsEnabled
  state.loadRanges = new Map(Object.entries(p.loadRanges || {}).map(([k, v]) => [Number(k), { ...v }]))
  $('nRows').value = String(p.n)
  $('nCols').value = String(p.m)
  $('loadsEnabled').checked = state.loadsEnabled
  clearAlerts()
  invalidateResults()
  buildGrid()
}

// 代价表容器在初始化时插入到网格下方

// —— 事件绑定 ——
$('applySize').addEventListener('click', applySize)
$('solveBtn').addEventListener('click', runSolve)
$('loadSample').addEventListener('click', () => loadPreset(SAMPLE))
$('loadLoads').addEventListener('click', () => loadPreset(LOADS_SAMPLE))
$('loadConflict').addEventListener('click', () => loadPreset(CONFLICT))
$('loadsEnabled').addEventListener('change', onLoadsEnabledChange)
$('clearAll').addEventListener('click', () => {
  state.cells = new Map()
  state.costs = new Map()
  state.loadRanges = new Map()
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
