// 无限位点（infinite sites）完美谱系补全求解器
//
// 约束：任意两列（突变）不得同时出现 11、10、01 三种配型，
// 等价于两列的载体集合在补全后必须互不相交或存在包含关系。
// 目标：在全部可行补全中精确最小化问号补值总代价（BigInt 任意精度整数）。
//
// 规模：4..18 个细胞（行）、3..12 个突变（列），未知格 ≤ 28。
// 不枚举保存全部完成矩阵：仅保留最优代价、规范补全与聚合计数。
//
// 可选“逐细胞负荷约束”（input.loads.enabled）：为每个细胞给出最终为 1 的
// 突变数闭区间 [lo,hi]（固定 1 也计入）。启用后列连通分量不再能独立取最优后
// 相乘——各分量保留“逐行负荷签名 → 最优聚合”的稀疏映射，分量间做稀疏
// (min,+) 卷积合并；既不枚举完成矩阵，也不是先求旧最优再过滤。

/**
 * 校验并规范化输入。
 * input: {
 *   matrix: Array<Array<0|1|-1>>,          // 行=细胞，列=突变；-1 表示问号
 *   costs:  Array<{c0: number|string|bigint, c1: number|string|bigint}>
 *           // 与问号按行优先顺序一一对应
 *   loads?: { enabled?: boolean,
 *             ranges?: Array<{lo:number, hi:number}|[number,number]|null|undefined> }
 *           // enabled 为真时逐行给出最终 1 数的闭区间（固定 1 计入）
 * }
 * 返回 { ok:true, n, m, fixed, unknowns, loads } 或 { ok:false, message }。
 * loads 规范化为 null（未启用）或 { enabled:true, lo:Int32Array, hi:Int32Array }。
 */
export function validateInput(input) {
  if (input === null || typeof input !== 'object') {
    return { ok: false, message: '输入必须是对象' }
  }
  const matrix = input.matrix
  if (!Array.isArray(matrix)) {
    return { ok: false, message: '矩阵必须是二维数组' }
  }
  const n = matrix.length
  if (!Number.isInteger(n) || n < 4 || n > 18) {
    return { ok: false, message: `细胞数必须为 4 至 18（当前 ${n}）` }
  }
  let m = null
  for (let i = 0; i < n; i++) {
    if (!Array.isArray(matrix[i])) {
      return { ok: false, message: `第 ${i + 1} 行不是数组` }
    }
    if (m === null) m = matrix[i].length
    else if (matrix[i].length !== m) {
      return { ok: false, message: `第 ${i + 1} 行长度与首行不一致` }
    }
  }
  if (!Number.isInteger(m) || m < 3 || m > 12) {
    return { ok: false, message: `突变数必须为 3 至 12（当前 ${m}）` }
  }
  const fixed = Array.from({ length: n }, () => new Int8Array(m))
  const unknowns = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      const v = matrix[r][c]
      if (v === 0 || v === 1) {
        fixed[r][c] = v
      } else if (v === -1 || v === '?' || v === null) {
        fixed[r][c] = -1
        unknowns.push({ r, c })
      } else {
        return { ok: false, message: `单元格（细胞 ${r + 1}, 突变 ${c + 1}）只能取 0、1 或问号` }
      }
    }
  }
  if (unknowns.length > 28) {
    return { ok: false, message: `未知格总数不得超过 28（当前 ${unknowns.length}）` }
  }
  if (!Array.isArray(input.costs) || input.costs.length !== unknowns.length) {
    return {
      ok: false,
      message: `代价条目数（${Array.isArray(input.costs) ? input.costs.length : '非数组'}）必须等于未知格数（${unknowns.length}）`,
    }
  }
  for (let i = 0; i < unknowns.length; i++) {
    const pair = input.costs[i]
    if (pair === null || typeof pair !== 'object') {
      return { ok: false, message: `第 ${i + 1} 个问号的代价必须是 {c0,c1}` }
    }
    const c0 = parseNonNegInt(pair.c0)
    const c1 = parseNonNegInt(pair.c1)
    if (c0 === null) return { ok: false, message: `第 ${i + 1} 个问号“填 0 代价”不是非负整数` }
    if (c1 === null) return { ok: false, message: `第 ${i + 1} 个问号“填 1 代价”不是非负整数` }
    unknowns[i].c0 = c0
    unknowns[i].c1 = c1
  }

  // —— 逐细胞负荷区间（可选） ——
  let loads = null
  const rawLoads = input.loads
  if (rawLoads !== null && typeof rawLoads === 'object' && rawLoads.enabled) {
    const lo = new Int32Array(n)
    const hi = new Int32Array(n)
    const ranges = Array.isArray(rawLoads.ranges) ? rawLoads.ranges : null
    if (!ranges || ranges.length !== n) {
      return { ok: false, message: `启用逐细胞负荷约束时，必须提供恰好 ${n} 个区间（当前 ${ranges ? ranges.length : '未提供'}）` }
    }
    for (let r = 0; r < n; r++) {
      const range = ranges[r]
      if (range === null || typeof range !== 'object') {
        return { ok: false, message: `细胞 ${r + 1} 的负荷区间缺失或格式错误，须为 {lo,hi} 或 [lo,hi]` }
      }
      let a, b
      if (Array.isArray(range)) { a = range[0]; b = range[1] }
      else { a = range.lo; b = range.hi }
      a = Number(a); b = Number(b)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > b) {
        return { ok: false, message: `细胞 ${r + 1} 的负荷区间非法：须满足 0 ≤ lo ≤ hi 的整数（当前 ${JSON.stringify([a, b])}）` }
      }
      if (b > m) {
        return { ok: false, message: `细胞 ${r + 1} 的负荷上限 ${b} 超过突变总数 ${m}` }
      }
      lo[r] = a
      hi[r] = b
    }
    loads = { enabled: true, lo, hi }
  }

  return { ok: true, n, m, fixed, unknowns, loads }
}

function parseNonNegInt(v) {
  if (typeof v === 'bigint') return v >= 0n ? v : null
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && v >= 0) return BigInt(v)
    return null
  }
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^\d+$/.test(t)) return BigInt(t)
  }
  return null
}

const bit = (r) => 1n << BigInt(r)

function popcount(x) {
  let c = 0
  while (x) { x &= x - 1n; c++ }
  return c
}

function maskRows(x) {
  const rows = []
  let r = 0
  while (x) {
    if (x & 1n) rows.push(r)
    x >>= 1n
    r++
  }
  return rows
}

// 两个已完全确定的列（ones 为载体位掩码）是否满足无限位点：
// 缺 11（不相交）、缺 10（A⊆B）或缺 01（B⊆A）
function compatibleComplete(onesA, onesB, ALL) {
  if ((onesA & onesB) === 0n) return true
  if ((onesA & ~onesB & ALL) === 0n) return true
  if ((onesB & ~onesA & ALL) === 0n) return true
  return false
}

// 位向量规范次序：从第 0 行起首个差异位，含该位（取 1）者为大
function cmpMask(a, b) {
  const x = a ^ b
  if (x === 0n) return 0
  const low = x & -x
  return (a & low) ? 1 : -1
}

function rowOfBit(b) {
  let r = 0
  while (!(b & 1n)) { b >>= 1n; r++ }
  return r
}

/**
 * 主求解入口。返回：
 *   { status:'error', message }
 *   { status:'conflict', conflicts:[{a,b, p11:[rows],p10:[rows],p01:[rows]}] }
 *   { status:'infeasible' }   // 固定数据无直接三配型冲突、但未知格也无法消解
 *   { status:'ok', optimumCost, optimumCount, matrix, calls, cloneTree }
 */
export function solve(input) {
  const v = validateInput(input)
  if (!v.ok) return { status: 'error', message: v.message }
  const { n, m, fixed, unknowns, loads } = v
  const ALL = (1n << BigInt(n)) - 1n

  // 每列固定 1 / 固定 0 / 未知行位掩码；问号全局索引查表（行优先）
  const f1 = new Array(m).fill(0n)
  const f0 = new Array(m).fill(0n)
  const U = new Array(m).fill(0n)
  const cellIndex = Array.from({ length: n }, () => new Int16Array(m).fill(-1))
  for (let c = 0; c < m; c++) {
    for (let r = 0; r < n; r++) {
      const x = fixed[r][c]
      if (x === 1) f1[c] |= bit(r)
      else if (x === 0) f0[c] |= bit(r)
    }
  }
  unknowns.forEach((u, i) => {
    U[u.c] |= bit(u.r)
    cellIndex[u.r][u.c] = i
  })

  // —— 1. 固定数据自身的三配型冲突（全部列出） ——
  const conflicts = []
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const p11 = f1[a] & f1[b]
      const p10 = f1[a] & f0[b]
      const p01 = f0[a] & f1[b]
      if (p11 && p10 && p01) {
        conflicts.push({ a, b, p11: maskRows(p11), p10: maskRows(p10), p01: maskRows(p01) })
      }
    }
  }
  if (conflicts.length) return { status: 'conflict', conflicts }

  // 固定 1 基线负荷（每行）
  const baseLoad = new Int32Array(n)
  for (let r = 0; r < n; r++) {
    let b = 0
    for (let c = 0; c < m; c++) if (fixed[r][c] === 1) b++
    baseLoad[r] = b
  }

  // —— 启用逐细胞负荷约束时的输入侧冲突预检 ——
  // 与“全局不可行”区分：这里仅凭固定值与问号位置即可判定（不动用搜索）。
  let loadConflicts = null
  if (loads) {
    loadConflicts = []
    for (let r = 0; r < n; r++) {
      const fixed1 = baseLoad[r]
      let maxExtra = 0
      for (let c = 0; c < m; c++) if (fixed[r][c] === -1) maxExtra++
      const reasons = []
      if (fixed1 > loads.hi[r]) {
        reasons.push({ code: 'over', row: r, fixed: fixed1, lo: loads.lo[r], hi: loads.hi[r] })
      }
      if (fixed1 + maxExtra < loads.lo[r]) {
        reasons.push({ code: 'under', row: r, fixed: fixed1, available: fixed1 + maxExtra, lo: loads.lo[r], hi: loads.hi[r] })
      }
      if (reasons.length) loadConflicts.push(...reasons)
    }
    if (loadConflicts.length) return { status: 'conflict', conflicts: [], loadConflicts }
  }

  // —— 2. 列约束依赖图：两列可能在某种补全下形成三配型才连边 ——
  // 三个见证行必须互异（相异代表系；每集恰取 1 个，等价于并集≥3
  // 且任意两集并集≥2：单元素集合相同的情况被排除）。
  const may1 = U.map((u, c) => f1[c] | u)
  const may0 = U.map((u, c) => f0[c] | u)
  const hasEdge = (a, b) => {
    const s11 = may1[a] & may1[b]
    const s10 = may1[a] & may0[b]
    const s01 = may0[a] & may1[b]
    if (!s11 || !s10 || !s01) return false
    if (popcount(s11 | s10 | s01) < 3) return false
    if (popcount(s11 | s10) < 2 || popcount(s11 | s01) < 2 || popcount(s10 | s01) < 2) return false
    return true
  }
  const adj = Array.from({ length: m }, () => [])
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      if (hasEdge(a, b)) {
        adj[a].push(b)
        adj[b].push(a)
      }
    }
  }

  // 连通分量：不同分量的未知格在约束与代价上均独立，分别求解后合并
  const compOf = new Int16Array(m).fill(-1)
  const components = []
  for (let c = 0; c < m; c++) {
    if (compOf[c] !== -1) continue
    const id = components.length
    const stack = [c]
    compOf[c] = id
    const cols = []
    while (stack.length) {
      const x = stack.pop()
      cols.push(x)
      for (const y of adj[x]) {
        if (compOf[y] === -1) { compOf[y] = id; stack.push(y) }
      }
    }
    components.push(cols.sort((a, b) => a - b))
  }

  // —— 3. 各分量求解 ——
  const ctx = { n, f1, f0, U, ALL, cellIndex, nUnknowns: unknowns.length }

  // 冗余检测：若每行区间都宽松到“任何补全都满足”（lo ≤ 固定1数 且
  // hi ≥ 固定1数 + 该行问号总数），负荷约束不改变可行集与最优，直接走原流程，
  // 仅在结果中附加负荷报告（避免为无效约束付出签名 DP 的指数代价）。
  let loadsRedundant = false
  if (loads) {
    loadsRedundant = true
    for (let r = 0; r < n; r++) {
      let qRow = 0
      for (let c = 0; c < m; c++) if (fixed[r][c] === -1) qRow++
      if (!(loads.lo[r] <= baseLoad[r] && loads.hi[r] >= baseLoad[r] + qRow)) {
        loadsRedundant = false
        break
      }
    }
  }

  if (!loads || loadsRedundant) {
    // 无有效负荷约束：分量独立取最优，代价相加、计数相乘（原流程，结果保持不变）
    let optimumCost = 0n
    let optimumCount = 1n
    const compResults = []
    let feasible = true

    for (const cols of components) {
      const cid = compOf[cols[0]]
      const vars = unknowns.filter((u) => compOf[u.c] === cid)
      const res = solveComponent(cols, vars, ctx)
      if (!res) { feasible = false; break }
      compResults.push(res)
      optimumCost += res.best
      optimumCount *= res.count
    }
    if (!feasible) return { status: 'infeasible' }

    // 规范补全中每个问号的取值，以及该问号在全部全局最优补全中的取 1 数
    //（分量内次数需乘以其余分量的计数乘积）
    const chosen = new Array(unknowns.length)
    const onesAmongOpt = new Array(unknowns.length).fill(0n)
    for (const res of compResults) {
      const otherFactor = optimumCount / res.count
      for (const gi of res.globalIndices) {
        chosen[gi] = res.canonical[gi]
        onesAmongOpt[gi] = res.onesCount[gi] * otherFactor
      }
    }
    return finalizeResult({ n, m, fixed, unknowns, cellIndex, chosen, onesAmongOpt, optimumCost, optimumCount, ALL, loads, baseLoad })
  }

  // —— 启用负荷约束：保留分量“逐行新增 1 数签名”的稀疏结构 ——
  // 多列分量（列间有 ISA 耦合边）：Map<逐行签名, 最小代价/计数/逐格取1数/规范向量>。
  // 单列分量（问号互不耦合）不各自建图：全部并入“按行独立分布”，
  // 最终与多列分量合并时按行做极小 DP，避免指数膨胀与枚举完成矩阵。
  const independentByRow = Array.from({ length: n }, () => []) // [{g,c0,c1}]
  const multiComps = [] // { cols, vars, rowCap:Int32Array }
  for (const cols of components) {
    const cid = compOf[cols[0]]
    const vars = unknowns.filter((u) => compOf[u.c] === cid)
    if (cols.length === 1) {
      for (const u of vars) {
        independentByRow[u.r].push({ g: cellIndex[u.r][u.c], c0: u.c0, c1: u.c1 })
      }
    } else {
      const rowCap = new Int32Array(n)
      for (const u of vars) rowCap[u.r]++
      multiComps.push({ cols, vars, rowCap })
    }
  }
  const indepRowCap = new Int32Array(n)
  for (let r = 0; r < n; r++) indepRowCap[r] = independentByRow[r].length

  // 每个多列分量的行级必要边界（来自全局区间与“其余问号容量”），
  // 在 DP 内即剪枝：need[r] ≤ 该分量签名[r] ≤ cap[r]。
  const compBounds = []
  for (let i = 0; i < multiComps.length; i++) {
    const need = new Int32Array(n), cap = new Int32Array(n)
    for (let r = 0; r < n; r++) {
      let otherCap = indepRowCap[r]
      for (let j = 0; j < multiComps.length; j++) {
        if (j !== i) otherCap += multiComps[j].rowCap[r]
      }
      need[r] = Math.max(0, loads.lo[r] - baseLoad[r] - otherCap)
      cap[r] = loads.hi[r] - baseLoad[r]
      if (cap[r] < 0) return { status: 'infeasible' }
    }
    compBounds.push({ need, cap })
  }

  // 每行独立问号的“新增 1 数 → 最小代价 / 计数 / 逐格取 1 数 / 规范赋值”分布
  const rowDists = independentByRow.map((cells) => buildRowDistribution(cells))

  // —— 阶段 A：只求最优值（valueOnly，不保留计数/见证/规范，亦不做代价剪枝） ——
  // 得到全局最优代价 V*，供阶段 B 作安全的分支限界上界。
  const valueProfiles = multiComps.map((mc, i) =>
    solveComponentProfile(mc.cols, mc.vars, ctx, compBounds[i], { valueOnly: true, ub: null }))
  for (const pm of valueProfiles) if (pm.size === 0) return { status: 'infeasible' }

  // 仅代价的森林签名卷积（小规模）
  const sigKey = (sig) => sig.join(',')
  let forestCost = new Map([[sigKey(new Int32Array(n)), { sig: new Int32Array(n), cost: 0n }]])
  const vOrder = valueProfiles.map((_, i) => i).sort((a, b) => valueProfiles[a].size - valueProfiles[b].size)
  for (const idx of vOrder) {
    const pm = valueProfiles[idx]
    const next = new Map()
    for (const a of forestCost.values()) {
      for (const b of pm.values()) {
        const sig = new Int32Array(n)
        for (let r = 0; r < n; r++) sig[r] = a.sig[r] + b.sig[r]
        const cost = a.cost + b.cost
        const key = sigKey(sig)
        const hit = next.get(key)
        if (hit === undefined || cost < hit.cost) next.set(key, { sig, cost })
      }
    }
    forestCost = next
    if (forestCost.size === 0) return { status: 'infeasible' }
  }
  // 联合按行独立分布求全局最优值 V*（行内最小代价，区间内取最小）
  let Vstar = null
  for (const e of forestCost.values()) {
    let total = e.cost, ok = true
    for (let r = 0; r < n; r++) {
      const kLo = Math.max(0, loads.lo[r] - baseLoad[r] - e.sig[r])
      const kHi = Math.min(indepRowCap[r], loads.hi[r] - baseLoad[r] - e.sig[r])
      if (kLo > kHi || kHi < 0) { ok = false; break }
      let rb = null
      for (let k = kLo; k <= kHi; k++) { const d = rowDists[r][k]; if (d && (rb === null || d.cost < rb)) rb = d.cost }
      if (rb === null) { ok = false; break }
      total += rb
    }
    if (ok && (Vstar === null || total < Vstar)) Vstar = total
  }
  if (Vstar === null) return { status: 'infeasible' }

  // 每个分量的安全分支限界预算：V* − 其余部分的可采纳下界。
  // 其余分量取下界（各签名最小代价之和），独立行取忽略负荷的最小代价。
  const compFloor = valueProfiles.map((pm) => {
    let f = null
    for (const e of pm.values()) if (f === null || e.cost < f) f = e.cost
    return f
  })
  const indepFloor = new Array(n).fill(0n)
  for (let r = 0; r < n; r++) {
    let f = null
    for (const d of rowDists[r]) if (d && (f === null || d.cost < f)) f = d.cost
    indepFloor[r] = f ?? 0n
  }
  const indepFloorSum = indepFloor.reduce((a, b) => a + b, 0n)

  // —— 阶段 B：以安全预算重算完整聚合（计数/逐格见证/规范代表） ——
  const forestProfiles = []
  for (let i = 0; i < multiComps.length; i++) {
    let outsideLB = indepFloorSum
    for (let j = 0; j < multiComps.length; j++) if (j !== i) outsideLB += compFloor[j]
    const budget = Vstar - outsideLB
    const pm = solveComponentProfile(multiComps[i].cols, multiComps[i].vars, ctx, compBounds[i], {
      valueOnly: false, ub: budget,
    })
    if (pm.size === 0) return { status: 'infeasible' }
    forestProfiles.push(pm)
  }

  // 多列分量签名稀疏 (min,+) 卷积；各分量问号集合互不相交，规范向量按位叠合。
  // 同签名取最小代价，等代价累加计数/逐格取1数，并保留行优先 0 优先规范代表。
  const order = forestProfiles.map((_, i) => i)
  order.sort((a, b) => forestProfiles[a].size - forestProfiles[b].size)
  const globalOrderedG = unknowns.map((u, i) => i) // 全局问号索引即行优先序
  const canonLessGlobal = (a, b) => {
    for (const g of globalOrderedG) {
      const x = a[g] ?? -1, y = b[g] ?? -1
      if (x !== y) return x === 0
    }
    return false
  }
  const zeroCanon = new Int8Array(unknowns.length).fill(-1)
  let forest = new Map([[sigKey(new Int32Array(n)), {
    sig: new Int32Array(n), cost: 0n, count: 1n, ones: new Map(), canon: zeroCanon,
  }]])
  for (const idx of order) {
    const pm = forestProfiles[idx]
    const next = new Map()
    for (const a of forest.values()) {
      for (const b of pm.values()) {
        const sig = new Int32Array(n)
        for (let r = 0; r < n; r++) sig[r] = a.sig[r] + b.sig[r]
        // 最终总代价必然 > V* 的组合直接丢弃（安全：其余取行下界也无法挽回）
        if (a.cost + b.cost > Vstar - indepFloorSum) continue
        const canon = a.canon.slice()
        for (const g of pm.gs) canon[g] = b.canon[g]
        mergeProfileEntry(next, sigKey(sig), {
          sig,
          cost: a.cost + b.cost,
          count: a.count * b.count,
          ones: combineOnes(a.ones, b.ones, a.count, b.count),
          canon,
        }, canonLessGlobal)
      }
    }
    forest = next
    if (forest.size === 0) return { status: 'infeasible' }
  }

  // —— 与按行独立分布联合：求全局最优、计数与逐格见证（只遍历稀疏森林签名） ——
  const witness = witnessWithLoads({
    forest, rowDists, loads, baseLoad, n, nUnknowns: unknowns.length,
  })
  if (witness === null) return { status: 'infeasible' }
  const { optimumCost, optimumCount, chosen, onesAmongOpt } = witness


  return finalizeResult({ n, m, fixed, unknowns, cellIndex, chosen, onesAmongOpt, optimumCost, optimumCount, ALL, loads, baseLoad })
}

function finalizeResult({ n, m, fixed, unknowns, cellIndex, chosen, onesAmongOpt, optimumCost, optimumCount, ALL, loads, baseLoad }) {
  // 组装规范矩阵与问号裁决
  const matrix = Array.from({ length: n }, (_, r) =>
    Array.from({ length: m }, (_, c) =>
      fixed[r][c] === -1 ? chosen[cellIndex[r][c]] : fixed[r][c]))
  const calls = unknowns.map((u, i) => {
    let kind
    if (onesAmongOpt[i] === 0n) kind = 'fixed0'
    else if (onesAmongOpt[i] === optimumCount) kind = 'fixed1'
    else kind = 'free'
    return { r: u.r, c: u.c, kind }
  })

  const result = {
    status: 'ok',
    optimumCost,
    optimumCount,
    matrix,
    calls,
    cloneTree: buildCloneTree(matrix, n, ALL),
  }

  // 启用负荷约束时附带每个细胞的最终负荷与区间余量
  if (loads) {
    result.loads = Array.from({ length: n }, (_, r) => {
      const final = rowFinalLoad(matrix, r, m)
      return {
        row: r,
        lo: loads.lo[r],
        hi: loads.hi[r],
        final,
        // 区间余量：距下限/上限各还可增减多少（规范补全下均非负）
        loMargin: final - loads.lo[r],
        hiMargin: loads.hi[r] - final,
      }
    })
  }
  return result
}

function rowFinalLoad(matrix, r, m) {
  let t = 0
  for (let c = 0; c < m; c++) t += matrix[r][c]
  return t
}

function solveComponent(cols, vars, ctx) {
  const { n, f1, f0, U, ALL, cellIndex, nUnknowns: K } = ctx
  const L = cols.length
  const globalIndices = vars.map((u) => cellIndex[u.r][u.c])

  // 单列分量：问号互不耦合，逐格独立择优，无需搜索
  if (L === 1) {
    let best = 0n
    let ties = 0
    const canonical = {}
    const onesCount = {}
    for (const u of vars) {
      const k = cellIndex[u.r][u.c]
      best += u.c0 <= u.c1 ? u.c0 : u.c1
      canonical[k] = u.c0 <= u.c1 ? 0 : 1
      if (u.c0 === u.c1) ties++
    }
    const count = 1n << BigInt(ties)
    for (const u of vars) {
      const k = cellIndex[u.r][u.c]
      onesCount[k] = u.c0 === u.c1 ? count / 2n : (u.c1 < u.c0 ? count : 0n)
    }
    return { best, count, canonical, onesCount, globalIndices }
  }

  const E = buildComponentEngine(cols, vars, ctx)
  const { optionsFor, estimateCount, cloneInsert, lb, lU, makeForest } = E
  const ALLCOLS = (1 << L) - 1

  // —— 层状森林记忆化 DP ——
  // 状态 = （未放置列集合 remain，已放置载体构成的层状族 F，已花费 spent）。
  // (min,+) 半环聚合计数；同代价仅保留行优先 0 优先的唯一规范代表。
  // 只保存聚合结果，不枚举保存任何完整补全矩阵集合。
  const memo = new Map()

  function stateKey(remain, F, spent) {
    let k = remain.toString(36) + ',' + spent.toString(36)
    const masks = F.m.slice(1)
    masks.sort((a, b) => cmpMask(a, b))
    for (const msk of masks) k += '|' + msk.toString(36)
    return k
  }

  // 贪心：按 MRV 与代价升序尽快找到一个可行补全，作为初始最优上界
  const incumbent = { v: null }
  function greedy(remain, F, spent) {
    if (remain === 0) { incumbent.v = spent; return true }
    let pick = -1, pickEst = Infinity
    for (let ci = 0; ci < L; ci++) {
      if (!(remain & (1 << ci))) continue
      const e = estimateCount(ci, F)
      if (e === 0) return false
      if (e < pickEst || (e === pickEst && popcount(lU[ci]) > popcount(lU[pick]))) {
        pick = ci; pickEst = e
      }
    }
    const opts = optionsFor(pick, F)
    opts.sort((a, b) => a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0)
    const nextRemain = remain & ~(1 << pick)
    for (const o of opts) {
      const nf = o.existing ? F : cloneInsert(F, o)
      if (greedy(nextRemain, nf, spent + o.cost)) return true
    }
    return false
  }
  greedy(ALLCOLS, makeForest(), 0n)
  void n

  function rec(remain, F, spent) {
    if (remain === 0) {
      if (incumbent.v === null || spent < incumbent.v) incumbent.v = spent
      return { best: 0n, count: 1n, ones: new Map(), canon: new Int8Array(K).fill(-1) }
    }
    const k = stateKey(remain, F, spent)
    const cached = memo.get(k)
    if (cached !== undefined) return cached

    // MRV：用廉价估计排序，只对选中列精确枚举载体
    let pick = -1, pickEst = Infinity
    for (let ci = 0; ci < L; ci++) {
      if (!(remain & (1 << ci))) continue
      const e = estimateCount(ci, F)
      if (e === 0) {
        const dead = { best: null, count: 0n, ones: new Map(), canon: null }
        memo.set(k, dead)
        return dead
      }
      if (e < pickEst || (e === pickEst && popcount(lU[ci]) > popcount(lU[pick]))) {
        pick = ci; pickEst = e
      }
    }
    const pickOpts = optionsFor(pick, F)
    if (pickOpts.length === 0) {
      const dead = { best: null, count: 0n, ones: new Map(), canon: null }
      memo.set(k, dead)
      return dead
    }
    // 代价升序优先（并列：取 1 少者、位向量小者），尽早收紧上界
    pickOpts.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1
      const d = popcount(a.s) - popcount(b.s)
      if (d !== 0) return d
      return cmpMask(a.s, b.s)
    })

    const nextRemain = remain & ~(1 << pick)
    let best = null
    let count = 0n
    const ones = new Map()
    let bestCanon = null

    for (const o of pickOpts) {
      // 可采纳下界剪枝：严格大于已知上界才舍弃（等号可能是另一个最优补全）
      if (incumbent.v !== null && spent + o.cost + lb[nextRemain] > incumbent.v) continue
      const nf = o.existing ? F : cloneInsert(F, o)
      const sub = rec(nextRemain, nf, spent + o.cost)
      if (sub.count === 0n) continue
      const total = o.cost + sub.best

      const full = sub.canon.slice()
      let x2 = lU[pick]
      while (x2) {
        const b = x2 & -x2
        x2 ^= b
        full[cellIndex[rowOfBit(b)][cols[pick]]] = (o.s & b) ? 1 : 0
      }

      const tie = best !== null && total === best
      const take = best === null || total < best || (tie && E.canonLess(full, bestCanon))
      if (take) {
        best = total
        if (!tie) {
          count = sub.count
          ones.clear()
        } else {
          count += sub.count
        }
        for (const [g, num] of sub.ones) ones.set(g, (ones.get(g) ?? 0n) + num)
        x2 = lU[pick]
        while (x2) {
          const b = x2 & -x2
          x2 ^= b
          if (o.s & b) {
            const g = cellIndex[rowOfBit(b)][cols[pick]]
            ones.set(g, (ones.get(g) ?? 0n) + sub.count)
          }
        }
        bestCanon = full
      } else if (tie) {
        count += sub.count
        for (const [g, num] of sub.ones) ones.set(g, (ones.get(g) ?? 0n) + num)
        x2 = lU[pick]
        while (x2) {
          const b = x2 & -x2
          x2 ^= b
          if (o.s & b) {
            const g = cellIndex[rowOfBit(b)][cols[pick]]
            ones.set(g, (ones.get(g) ?? 0n) + sub.count)
          }
        }
      }
    }
    const entry = best === null
      ? { best: null, count: 0n, ones: new Map(), canon: null }
      : { best, count, ones, canon: bestCanon }
    memo.set(k, entry)
    return entry
  }

  const root = rec(ALLCOLS, makeForest(), 0n)
  if (root.count === 0n) return null

  const canonical = {}
  const onesCount = {}
  for (const u of vars) {
    const g = cellIndex[u.r][u.c]
    canonical[g] = root.canon[g]
    onesCount[g] = root.ones.get(g) ?? 0n
  }
  return { best: root.best, count: root.count, canonical, onesCount, globalIndices }
}

// 提取层状包含森林的全部共享机制（原求解器与负荷签名求解器共用，机制不变）
function buildComponentEngine(cols, vars, ctx) {
  const { n, f1, f0, U, ALL, cellIndex, nUnknowns: K } = ctx
  const L = cols.length
  const lf1 = cols.map((c) => f1[c])
  const lf0 = cols.map((c) => f0[c])
  const lU = cols.map((c) => U[c])
  const varAt = new Map()
  for (const u of vars) varAt.set(`${u.r},${u.c}`, u)

  // 行优先序的全局问号索引（规范补全比较次序：0 优先）
  const orderedG = [...vars]
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map((u) => cellIndex[u.r][u.c])

  // 列 ci 的未知格补值代价（按 s 位掩码）
  const maskCost = new Array(L)
  for (let ci = 0; ci < L; ci++) {
    const cache = new Map()
    maskCost[ci] = (s) => {
      const hit = cache.get(s)
      if (hit !== undefined) return hit
      let cost = 0n
      let x = lU[ci]
      while (x) {
        const b = x & -x
        x ^= b
        const u = varAt.get(`${rowOfBit(b)},${cols[ci]}`)
        cost += (s & b) ? u.c1 : u.c0
      }
      cache.set(s, cost)
      return cost
    }
  }

  // —— 层状包含树 ——
  // nodes[0] 为虚拟全集根；每个节点 z = 自身区域（载体减去子节点载体）。
  // 与现有层状族 laminar 的新载体，只能挂在某个节点 p 下：
  // S = ⋃(选中的 p 的子树载体) ∪ T，其中 T ⊆ z_p（再受固定值约束）。
  function makeForest() {
    return {
      m: [ALL],
      z: [ALL],
      children: [[]],
      parent: [-1],
      maskToNode: new Map([[ALL, 0]]),
    }
  }
  function insertForest(F, p, S, packed) {
    const id = F.m.length
    let zS = S
    for (const w of packed) zS &= ~F.m[w]
    F.m.push(S); F.z.push(zS); F.children.push(packed.slice()); F.parent.push(p)
    F.children[p] = F.children[p].filter((w) => !packed.includes(w)).concat(id)
    F.z[p] &= ~S
    F.maskToNode.set(S, id)
  }

  // 生成列 ci 在当前森林下的全部可行载体选项（结构枚举，非 2^u 暴力）
  function optionsFor(ci, F) {
    const byMask = new Map()
    const fixed1 = lf1[ci], fixed0 = lf0[ci], free = lU[ci]
    for (let p = 0; p < F.m.length; p++) {
      // 列的全部固定 1 行都必须落在候选父载体 F.m[p] 内，否则无法挂在 p 下
      if ((fixed1 & ~F.m[p] & ALL) !== 0n) continue
      // 子节点按全取约束分类：required 必须打包；其余子节点可选；
      // 含固定 0 的子节点绝不能打包（t⊆z_p 也无法越界取到其中的行，故仅排除即可）
      const required = [], optional = []
      let bad = false
      for (const w of F.children[p]) {
        const mw = F.m[w]
        const has0 = (mw & fixed0) !== 0n
        const has1 = (mw & fixed1) !== 0n
        if (has0 && has1) { bad = true; break }
        if (!has0 && has1) required.push(w)
        else if (!has0) optional.push(w)
        // has0 为真：禁止打包，不列入任何枚举
      }
      if (bad) continue
      // z_p 区域：固定1行必须纳入 T；固定0行不可纳入；未知行自由
      const zp = F.z[p]
      const mand = zp & fixed1
      const loose = zp & free
      // 必含子树（本列在其中有固定 1 行）的载体并集
      let reqUnion = 0n
      for (const w of required) reqUnion |= F.m[w]
      // 可选子节点的子集枚举
      for (let oi = 0; oi < (1 << optional.length); oi++) {
        let packed = required.slice()
        let union = mand | reqUnion
        for (let j = 0; j < optional.length; j++) {
          if (oi & (1 << j)) {
            const w = optional[j]
            packed.push(w)
            union |= F.m[w]
          }
        }
        for (let t = loose; ; t = (t - 1n) & loose) {
          const S = union | t
          if (!byMask.has(S)) {
            byMask.set(S, {
              s: S & free,
              S,
              cost: maskCost[ci](S & free),
              p,
              packed: packed.slice(),
              existing: S === 0n || F.maskToNode.has(S),
            })
          }
          if (t === 0n) break
        }
      }
    }
    return [...byMask.values()]
  }

  // 廉价估计列 ci 在森林 F 下的可行载体数（上界，仅供 MRV 排序）
  function estimateCount(ci, F) {
    const fixed1 = lf1[ci], fixed0 = lf0[ci], free = lU[ci]
    let total = 0
    for (let p = 0; p < F.m.length; p++) {
      if ((fixed1 & ~F.m[p] & ALL) !== 0n) continue
      let feasible = true
      let optional = 0
      for (const w of F.children[p]) {
        const has0 = (F.m[w] & fixed0) !== 0n
        const has1 = (F.m[w] & fixed1) !== 0n
        if (has0 && has1) { feasible = false; break }
        if (!has0 && !has1) optional++
      }
      if (!feasible) continue
      total += 1 << (optional + popcount(F.z[p] & free))
      if (total > 1e9) return 1e9
    }
    return total
  }

  function cloneInsert(F, o) {
    const nf = {
      m: F.m.slice(),
      z: F.z.slice(),
      children: F.children.map((a) => a.slice()),
      parent: F.parent.slice(),
      maskToNode: new Map(F.maskToNode),
    }
    insertForest(nf, o.p, o.S, o.packed)
    return nf
  }

  // 可采纳下界：剩余各列忽略层状约束时的独立最小补值代价之和
  const colMin = new Array(L).fill(0n)
  for (let ci = 0; ci < L; ci++) {
    let x = lU[ci]
    while (x) {
      const b = x & -x
      x ^= b
      const u = varAt.get(`${rowOfBit(b)},${cols[ci]}`)
      colMin[ci] += u.c0 < u.c1 ? u.c0 : u.c1
    }
  }
  const lb = new Array(1 << L).fill(0n)
  for (let mask = 1; mask < (1 << L); mask++) {
    const low = mask & -mask
    lb[mask] = lb[mask ^ low] + colMin[31 - Math.clz32(low)]
  }

  // 两个候选赋值向量（-1=未涉及）按行优先序比较：首个差异处取 0 者小
  function canonLess(a, b) {
    for (const g of orderedG) {
      const x = a[g], y = b[g]
      if (x !== y) return x === 0
    }
    return false
  }

  return {
    n, L, K, cols, lf1, lf0, lU, varAt, cellIndex, orderedG, globalIndices: orderedG,
    maskCost, makeForest, insertForest, optionsFor, estimateCount, cloneInsert,
    colMin, lb, canonLess,
  }
}

// 负荷模式：求一个多列分量的“逐行新增 1 数签名 → 最小代价聚合”稀疏映射。
// bounds = { need, cap } 行级必要区间；cut = { ub:BigInt|null, lbByMask }：
//   ub 为当前最优可行上界（分支限界，严格大于才舍弃，等值得保留以计见证）；
//   lbByMask[remain] 为剩余列忽略层状/负荷时的可采纳代价下界。
// 签名只压缩到本分量问号涉及的行。记忆化按 (remain, 森林形状, 已累计签名)，
// 与已花费无关；但分支限界依绝对花费，故每条缓存记录其“最小到达花费”，
// 只有以不大于当前花费（更宽松）算出的缓存才可复用，否则以更小花费重算。
// 返回 Map<sigKey, { sig(n长), cost, count, ones, canon }>（附 gs/activeRows/valueOnly）。
function solveComponentProfile(cols, vars, ctx, bounds, cut) {
  const { n, cellIndex } = ctx
  const E = buildComponentEngine(cols, vars, ctx)
  const { L, K, lU, optionsFor, estimateCount, cloneInsert, makeForest, canonLess, lb: lbByMask } = E
  const ALLCOLS = (1 << L) - 1
  const valueOnly = !!cut.valueOnly // 阶段一只需最优值：每签名不保留计数/见证/规范

  // 本分量问号涉及的行（局部索引 ↔ 全局行）
  const rowSet = new Set()
  for (const u of vars) rowSet.add(u.r)
  const activeRows = [...rowSet].sort((a, b) => a - b)
  const na = activeRows.length
  const localOf = new Int16Array(n).fill(-1)
  activeRows.forEach((r, i) => { localOf[r] = i })
  const needL = activeRows.map((r) => bounds.need[r])

  // 各 remain 掩码下、每个活动行尚待放置的问号数（行级剪枝）
  const remByMask = new Array(1 << L)
  remByMask[0] = new Int32Array(na)
  for (let mask = 1; mask < (1 << L); mask++) {
    const low = mask & -mask
    const ci = 31 - Math.clz32(low)
    const prev = remByMask[mask ^ low]
    const cur = new Int32Array(na)
    let x = lU[ci]
    while (x) { const b = x & -x; x ^= b; const li = localOf[rowOfBit(b)]; if (li >= 0) cur[li]++ }
    for (let i = 0; i < na; i++) cur[i] += prev[i]
    remByMask[mask] = cur
  }
  const capL = activeRows.map((r, i) => Math.min(bounds.cap[r], remByMask[ALLCOLS][i]))

  const sigKeyOf = (sig) => sig.join(',')
  const memo = new Map() // key -> { minSpent:bigint, map }

  function rec(remain, F, partial, spent) {
    if (remain === 0) {
      const m = new Map()
      m.set(sigKeyOf(partial), valueOnly
        ? { sig: partial.slice(), best: 0n }
        : { sig: partial.slice(), best: 0n, count: 1n, ones: new Map(), canon: new Int8Array(K).fill(-1) })
      return m
    }
    const key = remain.toString(36) + ';' + sigKeyOf(partial) + ';' + forestShapeKey(F)
    const cached = memo.get(key)
    // 仅当缓存以不大于当前到达花费计算（裁剪更宽松、结果是超集）时复用
    if (cached !== undefined && cached.minSpent <= spent) return cached.map

    let pick = -1, pickEst = Infinity
    for (let ci = 0; ci < L; ci++) {
      if (!(remain & (1 << ci))) continue
      const e = estimateCount(ci, F)
      if (e === 0) { memo.set(key, { minSpent: spent, map: new Map() }); return memo.get(key).map }
      if (e < pickEst || (e === pickEst && popcount(lU[ci]) > popcount(lU[pick]))) {
        pick = ci; pickEst = e
      }
    }
    const pickOpts = optionsFor(pick, F)
    pickOpts.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1
      const d = popcount(a.s) - popcount(b.s)
      if (d !== 0) return d
      return cmpMask(a.s, b.s)
    })

    const nextRemain = remain & ~(1 << pick)
    const remRows = remByMask[nextRemain]
    const out = new Map()

    for (const o of pickOpts) {
      const spentAfter = spent + o.cost
      // 可采纳下界剪枝：严格大于已知上界才舍弃（等值可能是最优补全，须保留）
      if (cut.ub !== null && spentAfter + lbByMask[nextRemain] > cut.ub) continue

      let xb = lU[pick]
      const addRows = new Int32Array(na)
      while (xb) {
        const b = xb & -xb
        xb ^= b
        const li = localOf[rowOfBit(b)]
        if (li >= 0 && (o.s & b)) addRows[li]++
      }
      const nextPartial = new Int32Array(na)
      let prune = false
      for (let i = 0; i < na; i++) {
        const v = partial[i] + addRows[i]
        if (v > capL[i] || v + remRows[i] < needL[i]) { prune = true; break }
        nextPartial[i] = v
      }
      if (prune) continue

      const nf = o.existing ? F : cloneInsert(F, o)
      const sub = rec(nextRemain, nf, nextPartial, spentAfter)
      for (const e of sub.values()) {
        const total = o.cost + e.best
        // 绝对代价上界再过滤（复用到达花费更大的超集缓存时的保险）
        if (cut.ub !== null && spent + total > cut.ub) continue
        const sKey = sigKeyOf(e.sig)
        const hit = out.get(sKey)
        if (valueOnly) {
          if (hit === undefined || total < hit.best) out.set(sKey, { sig: e.sig, best: total })
          continue
        }
        const full = e.canon.slice()
        let x2 = lU[pick]
        while (x2) {
          const b = x2 & -x2
          x2 ^= b
          full[cellIndex[rowOfBit(b)][cols[pick]]] = (o.s & b) ? 1 : 0
        }
        const ones = new Map(e.ones)
        x2 = lU[pick]
        while (x2) {
          const b = x2 & -x2
          x2 ^= b
          if (o.s & b) {
            const g = cellIndex[rowOfBit(b)][cols[pick]]
            ones.set(g, (ones.get(g) ?? 0n) + e.count)
          }
        }
        if (hit === undefined) {
          out.set(sKey, { sig: e.sig, best: total, count: e.count, ones, canon: full })
        } else if (total < hit.best) {
          hit.best = total; hit.count = e.count; hit.ones = ones; hit.canon = full
        } else if (total === hit.best) {
          hit.count += e.count
          for (const [g, num] of ones) hit.ones.set(g, (hit.ones.get(g) ?? 0n) + num)
          if (canonLess(full, hit.canon)) hit.canon = full
        }
      }
    }
    // 以到达该状态的最小花费登记缓存（结果最宽松、可被更大花费安全复用）
    if (cached === undefined || spent < cached.minSpent) memo.set(key, { minSpent: spent, map: out })
    return out
  }

  // 阶段 B 且外部未给预算时，用贪心求一个可行上界供分支限界。
  // 阶段 A（valueOnly）传 ub=null，必须不做代价剪枝、保留全部签名。
  if (!valueOnly && (cut.ub === null || cut.ub === undefined)) {
    const gub = greedyProfileUB(E, activeRows, localOf, needL, capL, remByMask)
    if (gub !== null) cut.ub = gub
  }

  const root = rec(ALLCOLS, makeForest(), new Int32Array(na), 0n)
  const expanded = new Map()
  for (const e of root.values()) {
    // 统一展开为 n 长签名（非活动行恒 0）
    const sig = new Int32Array(n)
    for (let i = 0; i < na; i++) sig[activeRows[i]] = e.sig[i]
    if (valueOnly) { expanded.set(sig.join(','), { sig, cost: e.best }); continue }
    expanded.set(sig.join(','), { sig, cost: e.best, count: e.count, ones: e.ones, canon: e.canon })
  }
  expanded.gs = vars.map((u) => cellIndex[u.r][u.c])
  expanded.activeRows = activeRows
  expanded.optimum = root.size ? [...root.values()].reduce((a, e) => a === null || e.best < a ? e.best : a, null) : null
  return expanded
}

// 负荷感知贪心：MRV 选列、每步选满足行级必要条件且代价最小的载体，
// 末端校验完整签名落入 [need,cap]；返回一个可行补全的总代价或 null。
function greedyProfileUB(E, activeRows, localOf, needL, capL, remByMask) {
  const { L, lU, optionsFor, estimateCount, cloneInsert, makeForest } = E
  const ALLCOLS = (1 << L) - 1
  const na = activeRows.length
  function go(remain, F, partial, spent) {
    if (remain === 0) {
      for (let i = 0; i < na; i++) if (partial[i] < needL[i] || partial[i] > capL[i]) return null
      return spent
    }
    let pick = -1, pickEst = Infinity
    for (let ci = 0; ci < L; ci++) {
      if (!(remain & (1 << ci))) continue
      const est = estimateCount(ci, F)
      if (est === 0) return null
      if (est < pickEst || (est === pickEst && popcount(lU[ci]) > popcount(lU[pick]))) { pick = ci; pickEst = est }
    }
    const opts = optionsFor(pick, F)
    opts.sort((a, b) => a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0)
    const nextRemain = remain & ~(1 << pick)
    const remRows = remByMask[nextRemain]
    for (const o of opts) {
      let xb = lU[pick]
      const addRows = new Int32Array(na)
      while (xb) { const b = xb & -xb; xb ^= b; const li = localOf[rowOfBit(b)]; if (li >= 0 && (o.s & b)) addRows[li]++ }
      const np = new Int32Array(na)
      let ok = true
      for (let i = 0; i < na; i++) {
        const v = partial[i] + addRows[i]
        if (v > capL[i] || v + remRows[i] < needL[i]) { ok = false; break }
        np[i] = v
      }
      if (!ok) continue
      const nf = o.existing ? F : cloneInsert(F, o)
      const r = go(nextRemain, nf, np, spent + o.cost)
      if (r !== null) return r
    }
    return null
  }
  return go(ALLCOLS, makeForest(), new Int32Array(na), 0n)
}
function forestShapeKey(F) {
  const masks = F.m.slice(1)
  masks.sort((a, b) => cmpMask(a, b))
  return masks.map((m) => m.toString(36)).join('|')
}

// 合并两个签名聚合：同键 (min,+)，同代价累加计数与逐格取 1 数，并保留行优先规范代表
function mergeProfileEntry(map, key, obj, canonLess) {
  const hit = map.get(key)
  if (hit === undefined) {
    map.set(key, obj)
    return
  }
  if (obj.cost < hit.cost) {
    map.set(key, obj)
  } else if (obj.cost === hit.cost) {
    hit.count += obj.count
    for (const [g, num] of obj.ones) hit.ones.set(g, (hit.ones.get(g) ?? 0n) + num)
    if (canonLess(obj.canon, hit.canon)) hit.canon = obj.canon
  }
}

function combineOnes(a, b, countA, countB) {
  const out = new Map()
  for (const [g, num] of a) out.set(g, num * countB)
  for (const [g, num] of b) out.set(g, (out.get(g) ?? 0n) + num * countA)
  return out
}

// 同一行内彼此独立（单列分量）问号的分布：
// dist[k] = 恰好 k 个取 1 时的 { 最小代价 cost、补全数 count、逐格取1数 ones、规范赋值 canon }。
// cells: [{g,c0,c1}]，g 为全局问号索引（行内按 g 升序即列序）。
function buildRowDistribution(cells) {
  const t = cells.length
  const gs = [...cells].sort((a, b) => a.g - b.g)
  const BIG = (x) => BigInt(x)

  // 后缀 DP：suf[i][k] = 第 i..t-1 个问号恰好 k 个取 1 的最小代价；sw 为方式数
  const suf = Array.from({ length: t + 1 }, () => new Array(t + 1).fill(null))
  const sw = Array.from({ length: t + 1 }, () => new Array(t + 1).fill(0n))
  suf[t][0] = 0n; sw[t][0] = 1n
  for (let i = t - 1; i >= 0; i--) {
    for (let k = 0; k <= t - i; k++) {
      let best = null, w = 0n
      if (k <= t - i - 1 && suf[i + 1][k] !== null) {
        const c = BIG(gs[i].c0) + suf[i + 1][k]
        if (best === null || c < best) { best = c; w = sw[i + 1][k] }
        else if (c === best) w += sw[i + 1][k]
      }
      if (k - 1 >= 0 && suf[i + 1][k - 1] !== null) {
        const c = BIG(gs[i].c1) + suf[i + 1][k - 1]
        if (best === null || c < best) { best = c; w = sw[i + 1][k - 1] }
        else if (c === best) w += sw[i + 1][k - 1]
      }
      suf[i][k] = best; sw[i][k] = w
    }
  }

  // 前缀 DP：pre[i][j] = 前 i 个问号（0..i-1）恰好 j 个取 1 的最小代价；pw 为方式数
  const pre = Array.from({ length: t + 1 }, () => new Array(t + 1).fill(null))
  const pw = Array.from({ length: t + 1 }, () => new Array(t + 1).fill(0n))
  pre[0][0] = 0n; pw[0][0] = 1n
  for (let i = 0; i < t; i++) {
    for (let j = 0; j <= i; j++) {
      if (pre[i][j] === null) continue
      for (const v of [0, 1]) {
        const c = pre[i][j] + (v === 0 ? BIG(gs[i].c0) : BIG(gs[i].c1))
        const jj = j + v
        if (pre[i + 1][jj] === null || c < pre[i + 1][jj]) { pre[i + 1][jj] = c; pw[i + 1][jj] = pw[i][j] }
        else if (c === pre[i + 1][jj]) pw[i + 1][jj] += pw[i][j]
      }
    }
  }

  const dist = []
  for (let k = 0; k <= t; k++) {
    if (suf[0][k] === null) continue
    // 行优先 0 优先规范代表：逐位能取 0（仍存在最优后缀）则取 0
    const canon = new Map()
    let rem = k
    for (let i = 0; i < t; i++) {
      const g = gs[i].g
      if (rem <= t - i - 1 && suf[i + 1][rem] !== null &&
        BIG(gs[i].c0) + suf[i + 1][rem] === suf[i][rem]) {
        canon.set(g, 0)
      } else {
        canon.set(g, 1)
        rem--
      }
    }
    // 逐格取 1 数：前缀 j 个 1、本位 1、后缀 k-j-1 个 1，且总代价恰为最优
    const ones = new Map()
    for (let i = 0; i < t; i++) {
      const g = gs[i].g
      let num = 0n
      for (let j = 0; j <= i; j++) {
        const kk = k - j - 1
        if (kk < 0 || kk > t - i - 1) continue
        if (pre[i][j] === null || suf[i + 1][kk] === null) continue
        if (pre[i][j] + BIG(gs[i].c1) + suf[i + 1][kk] === suf[0][k]) {
          num += pw[i][j] * sw[i + 1][kk]
        }
      }
      ones.set(g, num)
    }
    dist[k] = { cost: suf[0][k], count: sw[0][k], ones, canon }
  }
  dist.gs = gs
  return dist
}

// 森林签名（多列分量合并结果）与按行独立分布的全局联合最优。
// 输出 { optimumCost, optimumCount, chosen:Int8Array, onesAmongOpt:BigInt64Array-like(Array) }
// 或 null（无可行组合）。
function witnessWithLoads({ forest, rowDists, loads, baseLoad, n, nUnknowns }) {
  let optimumCost = null
  const feasible = [] // { entry, perRow:[{best,ways,oneWays,canon}], total }

  for (const entry of forest.values()) {
    const f = entry.sig
    const perRow = []
    let sumRow = 0n
    let ok = true
    for (let r = 0; r < n; r++) {
      const kLo = Math.max(0, loads.lo[r] - baseLoad[r] - f[r])
      const kHi = Math.min(rowDists[r].length - 1, loads.hi[r] - baseLoad[r] - f[r])
      if (kLo > kHi || kHi < 0) { ok = false; break }
      let best = null, ways = 0n
      const oneWays = new Map()
      let bestCanon = null
      for (let k = kLo; k <= kHi; k++) {
        const d = rowDists[r][k]
        if (!d) continue
        if (best === null || d.cost < best) {
          best = d.cost
          ways = d.count
          oneWays.clear()
          for (const [g, num] of d.ones) oneWays.set(g, num)
          bestCanon = d.canon
        } else if (d.cost === best) {
          ways += d.count
          for (const [g, num] of d.ones) oneWays.set(g, (oneWays.get(g) ?? 0n) + num)
          if (canonLessRow(d.canon, bestCanon, rowDists[r].gs)) bestCanon = d.canon
        }
      }
      if (best === null || ways === 0n) { ok = false; break }
      perRow.push({ best, ways, oneWays, canon: bestCanon })
      sumRow += best
    }
    if (!ok) continue
    const total = entry.cost + sumRow
    if (optimumCost === null || total < optimumCost) optimumCost = total
    feasible.push({ entry, perRow, total })
  }
  if (optimumCost === null) return null

  let optimumCount = 0n
  const onesAmongOpt = new Array(nUnknowns).fill(0n)
  let bestFullCanon = null

  for (const { entry, perRow, total } of feasible) {
    if (total !== optimumCost) continue
    const waysProd = perRow.reduce((acc, p) => acc * p.ways, 1n)
    optimumCount += entry.count * waysProd
    // 多列分量问号
    for (const [g, num] of entry.ones) onesAmongOpt[g] += num * waysProd
    // 单列分量问号（按行，独立）
    for (let r = 0; r < n; r++) {
      let prodOther = 1n
      for (let r2 = 0; r2 < n; r2++) if (r2 !== r) prodOther *= perRow[r2].ways
      for (const [g, num] of perRow[r].oneWays) {
        onesAmongOpt[g] += entry.count * num * prodOther
      }
    }
    // 该森林签名下的行优先规范完整向量
    const vec = entry.canon.slice()
    for (let r = 0; r < n; r++) for (const [g, v] of perRow[r].canon) vec[g] = v
    if (bestFullCanon === null || canonLessVecArr(vec, bestFullCanon)) bestFullCanon = vec
  }

  return { optimumCost, optimumCount, chosen: bestFullCanon, onesAmongOpt }
}

function canonLessRow(a, b, gs) {
  for (const { g } of gs) {
    const x = a.get(g), y = b.get(g)
    if (x !== y) return x === 0
  }
  return false
}

// 以“全部问号全局索引升序”为序比较两个完整向量（-1=未涉及，不参与裁决）
function canonLessVecArr(a, b) {
  for (let g = 0; g < a.length; g++) {
    const x = a[g] ?? -1, y = b[g] ?? -1
    if (x !== y) return x === 0
  }
  return false
}

// 由补全矩阵的载体包含关系生成规范克隆树
export function buildCloneTree(matrix, n, ALL) {
  if (ALL === undefined) ALL = (1n << BigInt(n)) - 1n
  const m = matrix[0].length
  const byMask = new Map()
  const absent = []
  for (let c = 0; c < m; c++) {
    let mask = 0n
    for (let r = 0; r < n; r++) if (matrix[r][c] === 1) mask |= bit(r)
    if (mask === 0n) { absent.push(c); continue }
    if (!byMask.has(mask)) byMask.set(mask, { mask, muts: [c] })
    else byMask.get(mask).muts.push(c)
  }
  const nodes = [...byMask.values()]
  nodes.push({ mask: ALL, muts: [], root: true })
  for (const s of nodes) s.carriers = maskRows(s.mask)

  // 父节点 = 载体集严格包含 S 的最小（最贴近）集合
  for (const s of nodes) {
    if (s.mask === ALL) { s.parent = -1; continue }
    let bestI = -1
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i]
      if (t.mask === s.mask) continue
      if ((s.mask & ~t.mask & ALL) !== 0n) continue // S 不被 t 包含
      if (bestI === -1) { bestI = i; continue }
      const b0 = nodes[bestI]
      const dt = popcount(t.mask ^ s.mask)
      const db = popcount(b0.mask ^ s.mask)
      if (dt < db ||
        (dt === db && cmpMask(t.mask, b0.mask) < 0) ||
        (dt === db && t.mask === b0.mask && (t.muts[0] ?? m) < (b0.muts[0] ?? m))) {
        bestI = i
      }
    }
    s.parent = bestI
  }
  const children = Array.from({ length: nodes.length }, () => [])
  let root = -1
  nodes.forEach((s, i) => {
    if (s.parent === -1) root = i
    else children[s.parent].push(i)
  })
  // 规范次序：载体多者在前；并列按载体位向量、首个突变下标
  for (const ch of children) {
    ch.sort((i, j) => {
      const a = nodes[i], b = nodes[j]
      if (popcount(a.mask) !== popcount(b.mask)) return popcount(b.mask) - popcount(a.mask)
      const cm = cmpMask(a.mask, b.mask)
      if (cm !== 0) return cm
      return (a.muts[0] ?? m) - (b.muts[0] ?? m)
    })
  }
  const toNode = (i) => ({
    id: i,
    root: !!nodes[i].root,
    mutations: nodes[i].muts.slice(),
    carriers: nodes[i].carriers.slice(),
    children: children[i].map(toNode),
  })
  return { root: toNode(root), absentMutations: absent }
}
