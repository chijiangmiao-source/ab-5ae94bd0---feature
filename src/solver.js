// 无限位点（infinite sites）完美谱系补全求解器
//
// 约束：任意两列（突变）不得同时出现 11、10、01 三种配型，
// 等价于两列的载体集合在补全后必须互不相交或存在包含关系。
// 目标：在全部可行补全中精确最小化问号补值总代价（BigInt 任意精度整数）。
//
// 规模：4..18 个细胞（行）、3..12 个突变（列），未知格 ≤ 28。
// 不枚举保存全部完成矩阵：仅保留最优代价、规范补全与聚合计数。

/**
 * 校验并规范化输入。
 * input: {
 *   matrix: Array<Array<0|1|-1>>,          // 行=细胞，列=突变；-1 表示问号
 *   costs:  Array<{c0: number|string|bigint, c1: number|string|bigint}>
 *           // 与问号按行优先顺序一一对应
 *   loadEnabled: boolean (可选),           // 是否启用逐细胞突变负荷约束
 *   loads: Array<{lo, hi}> (启用时必填，n 条) // 每个细胞最终为 1 的突变数闭区间（含固定 1）
 * }
 * 返回 { ok:true, n, m, fixed, unknowns, loads } 或 { ok:false, message }。
 * 未启用时 loads 为 null；启用后行为与旧流程严格隔离。
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

  // 逐细胞突变负荷约束（可选）：为每个细胞填写最终 1 数闭区间，固定 1 也计入
  let loads = null
  if (input.loadEnabled === true) {
    if (!Array.isArray(input.loads) || input.loads.length !== n) {
      return {
        ok: false,
        message: `启用逐细胞负荷约束时，loads 必须是长度 ${n} 的数组（当前 ${Array.isArray(input.loads) ? input.loads.length : '非数组'}）`,
      }
    }
    loads = new Array(n)
    for (let r = 0; r < n; r++) {
      const pair = input.loads[r]
      if (pair === null || typeof pair !== 'object') {
        return { ok: false, message: `细胞 ${r + 1} 的负荷区间必须是 {lo,hi}` }
      }
      const lo = parseNonNegInt(pair.lo)
      const hi = parseNonNegInt(pair.hi)
      if (lo === null) return { ok: false, message: `细胞 ${r + 1} 的负荷下限不是非负整数` }
      if (hi === null) return { ok: false, message: `细胞 ${r + 1} 的负荷上限不是非负整数` }
      if (lo > hi) return { ok: false, message: `细胞 ${r + 1} 的负荷区间下限（${lo}）大于上限（${hi}）` }
      if (hi > BigInt(m)) return { ok: false, message: `细胞 ${r + 1} 的负荷上限（${hi}）超过突变数 ${m}` }
      loads[r] = { lo, hi }
    }
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
 *     // 含逐细胞负荷输入冲突（kind:'load'：固定 1 已超上限，或剩余问号也达不到下限）
 *   { status:'infeasible' }   // 输入无直接冲突、各分量组合后仍无满足全部约束的补全
 *   { status:'ok', optimumCost, optimumCount, matrix, calls, cloneTree, loadReport? }
 *
 * 启用 loadEnabled 后，负荷约束跨越列连通分量：分量不再独立取最优后相乘，
 * 而是保留每个分量各代价档的逐行负荷签名（稀疏 Map），在合并阶段做稀疏
 * 卷积选出全局最优；不枚举完成矩阵，也不先求旧最优再过滤。
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

  // 每个细胞的固定 1 数与问号数（负荷约束的基线）
  const fixedOneCnt = new Int16Array(n)
  const unknownCnt = new Int16Array(n)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < m; c++) {
      if (fixed[r][c] === 1) fixedOneCnt[r]++
      else if (fixed[r][c] === -1) unknownCnt[r]++
    }
  }

  // 启用负荷约束时的“输入冲突”（无需搜索即可判定）：
  //  over  —— 固定 1 数已超上限；
  //  under —— 即使该行全部问号填 1 也达不到下限。
  let loadConflicts = null
  if (loads) {
    loadConflicts = []
    for (let r = 0; r < n; r++) {
      const fx = Number(fixedOneCnt[r]), uq = Number(unknownCnt[r])
      if (BigInt(fx) > loads[r].hi) {
        loadConflicts.push({ kind: 'load', row: r, reason: 'over', fixed: fx, unknown: uq, lo: Number(loads[r].lo), hi: Number(loads[r].hi) })
      } else if (BigInt(fx + uq) < loads[r].lo) {
        loadConflicts.push({ kind: 'load', row: r, reason: 'under', fixed: fx, unknown: uq, lo: Number(loads[r].lo), hi: Number(loads[r].hi) })
      }
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
  // 未启用负荷约束：分量相互独立，各自取最优后代价相加、计数相乘（旧流程）。
  // 启用负荷约束：分量保留按“逐行问号取 1 数签名”聚合的全部代价档（稀疏
  // Map，绝不枚举完成矩阵），交由合并阶段做满足区间的稀疏卷积选全局最优。
  if (!loads) {
    let optimumCost = 0n
    let optimumCount = 1n
    const compResults = []
    for (const cols of components) {
      const cid = compOf[cols[0]]
      const vars = unknowns.filter((u) => compOf[u.c] === cid)
      const res = solveComponent(cols, vars, { n, f1, f0, U, ALL, cellIndex, nUnknowns: unknowns.length })
      if (!res) return { status: 'infeasible' }
      compResults.push(res)
      optimumCost += res.best
      optimumCount *= res.count
    }

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

    // —— 4. 组装规范矩阵与问号裁决 ——
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

    return {
      status: 'ok',
      optimumCost,
      optimumCount,
      matrix,
      calls,
      cloneTree: buildCloneTree(matrix, n, ALL),
    }
  }

  // —— 3L. 逐细胞负荷约束：各分量保留带负荷签名的代价档 ——
  // caps[r] = 细胞 r 的问号取 1 数全局上限（= 负荷上限 - 固定 1 数），
  // 分量内 DP 一旦超过即剪枝。
  // —— 3L. 逐细胞负荷约束：各分量保留带负荷签名的代价档 ——
  // caps[r] = 细胞 r 的问号取 1 数全局上限（= 负荷上限 - 固定 1 数）。
  const caps = new Int16Array(n)
  for (let r = 0; r < n; r++) caps[r] = Number(loads[r].hi) - fixedOneCnt[r]
  const floor0 = new Int16Array(n)
  for (let r = 0; r < n; r++) floor0[r] = Math.max(0, Number(loads[r].lo) - fixedOneCnt[r])
  const rowOfGlobal = new Int16Array(unknowns.length)
  unknowns.forEach((u, i) => { rowOfGlobal[i] = u.r })

  // 先整理分量元数据（不做搜索），再按“行支撑相交图”分超级组
  const compMeta = components.map((cols) => {
    const cid = compOf[cols[0]]
    const vars = unknowns.filter((u) => compOf[u.c] === cid)
    const ownTotal = new Int16Array(n)
    for (const u of vars) ownTotal[u.r]++
    return { cols, vars, ownTotal }
  })

  // 行支撑超级组：行集合两两不交的分量可独立最优（见 mergeLoadProfiles）
  const support = compMeta.map((cm) => {
    const m0 = new Uint8Array(n)
    for (const u of cm.vars) m0[u.r] = 1
    return m0
  })
  const superGroups = []
  {
    const superOf = new Int16Array(compMeta.length).fill(-1)
    for (let i = 0; i < compMeta.length; i++) {
      if (superOf[i] !== -1) continue
      const id = superGroups.length
      const rows = new Set()
      for (let r = 0; r < n; r++) if (support[i][r]) rows.add(r)
      const members = [i]
      superOf[i] = id
      let grew = true
      while (grew) {
        grew = false
        for (let j = i + 1; j < compMeta.length; j++) {
          if (superOf[j] !== -1) continue
          let share = false
          for (const r of rows) if (support[j][r]) { share = true; break }
          if (share) {
            superOf[j] = id
            members.push(j)
            for (let r = 0; r < n; r++) if (support[j][r]) rows.add(r)
            grew = true
          }
        }
      }
      superGroups.push(members)
    }
  }

  // 各分量的有效下界（组级目标减去组内其余分量的最大可能贡献）与上界；
  // 下放到分量 DP 做下界剪枝，避免枚举不可能抵达区间的签名。
  const compFloors = new Array(compMeta.length)
  const compCaps = new Array(compMeta.length)
  for (const members of superGroups) {
    const groupTotal = new Int16Array(n)
    const inGroup = new Uint8Array(n)
    for (const i of members) {
      for (let r = 0; r < n; r++) {
        groupTotal[r] += compMeta[i].ownTotal[r]
        if (compMeta[i].ownTotal[r]) inGroup[r] = 1
      }
    }
    for (const i of members) {
      const fl = new Int16Array(n)
      const cp = new Int16Array(n)
      for (let r = 0; r < n; r++) {
        // 下界只在本组行生效；其他行由别的超级组满足
        if (inGroup[r]) {
          const otherMax = groupTotal[r] - compMeta[i].ownTotal[r]
          fl[r] = Math.max(0, floor0[r] - otherMax)
        }
        cp[r] = Math.min(caps[r], compMeta[i].ownTotal[r])
      }
      compFloors[i] = fl
      compCaps[i] = cp
    }
  }

  const compProfiles = new Array(compMeta.length)
  for (let ci = 0; ci < compMeta.length; ci++) {
    const { cols, vars } = compMeta[ci]
    const prof = buildLoadProfile(cols, vars, {
      n, f1, f0, U, ALL, cellIndex, nUnknowns: unknowns.length,
      caps: compCaps[ci], floors: compFloors[ci], U,
    })
    if (prof === null) return { status: 'infeasible' } // 分量在组级区间下无可参与的签名
    compProfiles[ci] = prof
  }

  const merged = mergeLoadProfiles(compProfiles, {
    n, loads, fixedOneCnt, nUnknowns: unknowns.length, rowOfGlobal,
    superGroups, compFloors,
  })
  if (merged === null) return { status: 'infeasible' } // 各分量组合后无满足区间的解
  const { optimumCost, optimumCount, chosen, onesAmongOpt } = merged

  // —— 4L. 组装规范矩阵、问号裁决与逐细胞负荷报告 ——
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
  const loadReport = matrix.map((row, r) => {
    const finalLoad = row.reduce((s, v) => s + v, 0)
    return { row: r, load: finalLoad, lo: Number(loads[r].lo), hi: Number(loads[r].hi), slack: Number(loads[r].hi) - finalLoad }
  })

  return {
    status: 'ok',
    optimumCost,
    optimumCount,
    matrix,
    calls,
    cloneTree: buildCloneTree(matrix, n, ALL),
    loadReport,
  }
}

function solveComponent(cols, vars, ctx) {
  const engine = createForestEngine(cols, vars, ctx)
  return runClassic(cols, vars, ctx, engine)
}

// 共享的“层状包含森林”结构引擎：两个求解流程（旧最优 / 负荷剖面）复用
// 同一套载体选项生成与 MRV 估计，保证未启用负荷时算法与结果完全不变。
function createForestEngine(cols, vars, ctx) {
  const { n, f1, f0, U, ALL, cellIndex, nUnknowns: K } = ctx
  const L = cols.length
  const lf1 = cols.map((c) => f1[c])
  const lf0 = cols.map((c) => f0[c])
  const lU = cols.map((c) => U[c])
  const varAt = new Map()
  for (const u of vars) varAt.set(`${u.r},${u.c}`, u)
  const globalIndices = vars.map((u) => cellIndex[u.r][u.c])
  const varByGlobal = new Map(globalIndices.map((g, i) => [g, vars[i]]))

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

  return {
    n, K, L, cols, vars, lf1, lf0, lU, varAt, varByGlobal, globalIndices, orderedG,
    makeForest, cloneInsert, optionsFor, estimateCount,
  }
}

// 两个候选赋值向量（-1=未涉及）按全局问号行优先序比较：首个差异处取 0 者小
function canonLessAt(a, b, order) {
  for (const g of order) {
    const x = a[g], y = b[g]
    if (x !== y) return x === 0
  }
  return false
}

// —— 旧流程：分量独立取最优（(min,+) 记忆化 DP + 贪心上界剪枝）——
function runClassic(cols, vars, ctx, E) {
  const { K, L, lU, globalIndices, orderedG,
    makeForest, cloneInsert, optionsFor, estimateCount } = E
  const { cellIndex } = ctx

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

  // —— 层状森林记忆化 DP ——
  // 状态 = （未放置列集合 remain，已放置载体构成的层状族 F，已花费 spent）。
  // (min,+) 半环聚合计数；同代价仅保留行优先 0 优先的唯一规范代表。
  // 只保存聚合结果，不枚举保存任何完整补全矩阵集合。
  const memo = new Map()
  const ALLCOLS = (1 << L) - 1

  // 可采纳下界：剩余各列忽略层状约束时的独立最小补值代价之和
  const colMin = new Array(L).fill(0n)
  for (let ci = 0; ci < L; ci++) {
    let x = lU[ci]
    while (x) {
      const b = x & -x
      x ^= b
      const u = E.varAt.get(`${rowOfBit(b)},${cols[ci]}`)
      colMin[ci] += u.c0 < u.c1 ? u.c0 : u.c1
    }
  }
  const lb = new Array(1 << L).fill(0n)
  for (let mask = 1; mask < (1 << L); mask++) {
    const low = mask & -mask
    lb[mask] = lb[mask ^ low] + colMin[31 - Math.clz32(low)]
  }

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

  function fillPick(full, pick, s) {
    let x2 = lU[pick]
    while (x2) {
      const b = x2 & -x2
      x2 ^= b
      full[cellIndex[rowOfBit(b)][cols[pick]]] = (s & b) ? 1 : 0
    }
  }

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
      fillPick(full, pick, o.s)

      const tie = best !== null && total === best
      const take = best === null || total < best || (tie && canonLessAt(full, bestCanon, orderedG))
      if (take || tie) {
        if (take) {
          best = total
          if (!tie) {
            count = sub.count
            ones.clear()
          } else {
            count += sub.count
          }
        } else {
          count += sub.count
        }
        for (const [g, num] of sub.ones) ones.set(g, (ones.get(g) ?? 0n) + num)
        let x2 = lU[pick]
        while (x2) {
          const b = x2 & -x2
          x2 ^= b
          if (o.s & b) {
            const g = cellIndex[rowOfBit(b)][cols[pick]]
            ones.set(g, (ones.get(g) ?? 0n) + sub.count)
          }
        }
        if (take) bestCanon = full
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

// —— 负荷流程：分量保留“逐行问号取 1 数签名 → 最优代价档”的稀疏剖面 ——
//
// 签名紧凑编码：每个细胞 4 bit（计数 ≤ 12，无进位），一个 BigInt 即为签名，
// 直接充当稀疏 Map 的键，避免数组复制与字符串化。
//
// 两遍记忆化 DP，均只做聚合、绝不枚举保存完成矩阵：
//   第 1 遍（轻量）：(remain,F) → Map<签名, {cost,count}>，只算最小代价与计数；
//   第 2 遍（目标驱动）：合并阶段确定每个分量实际参与全局最优的目标签名集后，
//   仅沿第 1 遍中达到该签名最优代价的边递归，收集各问号取 1 次数与行优先 0 优先
//   规范代表。给定父签名与本列增量，子签名逐 nibble 唯一确定，故边的判定 O(行数)。
const NIB_BITS = 4n
const NIB_MASK = 15n

function sigNib(sig, r) {
  return Number((sig >> (BigInt(r) * NIB_BITS)) & NIB_MASK)
}
// 列问号取 1 行集合（位掩码）→ 签名增量（每行 +1）
function sigDelta(rowsMask, deltaCache) {
  const hit = deltaCache.get(rowsMask)
  if (hit !== undefined) return hit
  let d = 0n
  let x = rowsMask
  const rows = []
  while (x) { const b = x & -x; x ^= b; const r = rowOfBit(b); d += 1n << (BigInt(r) * NIB_BITS); rows.push(r) }
  const rec = { d, rows }
  deltaCache.set(rowsMask, rec)
  return rec
}
// sig + delta（每行至多 +1）；任一 nibble 超 cap 则返回 null
function sigAdvance(sig, delta, rows, caps) {
  for (const r of rows) {
    if (sigNib(sig, r) >= caps[r]) return null
  }
  return sig + delta
}
// 父签名减去列增量得到唯一子签名；某 nibble 下溢返回 null
function sigRetreat(sig, delta, rows) {
  for (const r of rows) {
    if (sigNib(sig, r) < 1) return null
  }
  return sig - delta
}

function buildLoadProfile(cols, vars, ctx) {
  const E = createForestEngine(cols, vars, ctx)
  const { n, K, L, lU, globalIndices, orderedG,
    makeForest, cloneInsert, optionsFor, estimateCount } = E
  const { caps, floors, U } = ctx
  const deltaCache = new Map()
  const deltaOf = (s) => sigDelta(s, deltaCache)

  // 各未放置列集合在每行的问号取 1 数上界（下界剪枝：部分签名 + 未来上界
  // 仍达不到该分量被分配的逐行有效下限时，该签名必无可参与的补全）
  const colRowMax = cols.map((c) => {
    const a = new Int16Array(n)
    let x = U[c]
    while (x) { const b = x & -x; x ^= b; a[rowOfBit(b)]++ }
    return a
  })
  const ownTotal = new Int16Array(n)
  for (const a of colRowMax) for (let r = 0; r < n; r++) ownTotal[r] += a[r]
  const futureMax = new Array(1 << L)
  futureMax[0] = new Int16Array(n)
  for (let mask = 1; mask < (1 << L); mask++) {
    const low = mask & -mask
    const ci = 31 - Math.clz32(low)
    const prev = futureMax[mask ^ low]
    const a = new Int16Array(n)
    for (let r = 0; r < n; r++) a[r] = prev[r] + colRowMax[ci][r]
    futureMax[mask] = a
  }
  // rec1(remain) 的子签名只覆盖 remain 内列；祖先还将放置的列在每行最多贡献
  // ownTotal - futureMax[remain]。子签名 + 该外部上界仍达不到有效下限时必废。
  const floorRows = []
  for (let r = 0; r < n; r++) if (floors[r]) floorRows.push(r)
  const canReachFloor = (sig, remainMask) => {
    if (floorRows.length === 0) return true
    const fut = futureMax[remainMask]
    for (const r of floorRows) {
      const extMax = ownTotal[r] - fut[r]
      if (sigNib(sig, r) + extMax < floors[r]) return false
    }
    return true
  }

  function optCmp(a, b) {
    if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1
    const d = popcount(a.s) - popcount(b.s)
    if (d !== 0) return d
    return cmpMask(a.s, b.s)
  }
  function stateKey(remain, F) {
    let k = remain.toString(36)
    const masks = F.m.slice(1)
    masks.sort((a, b) => cmpMask(a, b))
    for (const msk of masks) k += '|' + msk.toString(36)
    return k
  }

  // —— 单列分量：问号互不耦合，逐格折叠轻量签名档 ——
  // singleLayers[i] = 折叠完前 i+1 个问号后的 Map<sig,{cost,count}>
  function buildSingle() {
    const layers = []
    let map = new Map([[0n, { cost: 0n, count: 1n }]])
    for (let gi = 0; gi < orderedG.length; gi++) {
      const g = orderedG[gi]
      const u = E.varByGlobal.get(g)
      const dr = deltaOf(bit(u.r))
      // 本层之后仍未折叠的问号（索引 > gi）在每行的最大贡献
      const restMax = new Int16Array(n)
      for (let j = gi + 1; j < orderedG.length; j++) restMax[E.varByGlobal.get(orderedG[j]).r]++
      const next = new Map()
      for (const [sig, e] of map) {
        for (const val of [0, 1]) {
          const ns = val ? sigAdvance(sig, dr.d, dr.rows, caps) : sig
          if (ns === null) continue
          if (floors) {
            let reach = true
            for (let r = 0; r < n; r++) {
              if (floors[r] && sigNib(ns, r) + restMax[r] < floors[r]) { reach = false; break }
            }
            if (!reach) continue
          }
          const cost = e.cost + (val ? u.c1 : u.c0)
          const cur = next.get(ns)
          if (cur === undefined) next.set(ns, { cost, count: e.count })
          else if (cost < cur.cost) { cur.cost = cost; cur.count = e.count }
          else if (cost === cur.cost) cur.count += e.count
        }
      }
      layers.push(next)
      map = next
    }
    return layers
  }

  // —— 多列分量：层状森林轻量记忆化 DP ——
  // 状态键只由（剩余列集合, 森林非根载体掩码集合）决定：插入一列只是向该集合
  // 增加其载体掩码（已有掩码或空载体时集合不变）。故子状态键可不经森林克隆直接
  // 算出；命中记忆时跳过 cloneInsert，仅在真正未算过的子状态上克隆并递归。
  const memo1 = new Map()
  const nodes = new Map() // stateKey -> { remain, pick, edges:[{o, ck, dr}] }
  const ALLCOLS = (1 << L) - 1

  // 依据“父森林非根掩码（已规范排序）+ 本列载体”拼出子状态的掩码部分
  // （'|' 分隔、不含前导 '|'；无掩码时为空串）
  function maskSuffixInsert(sortedMasks, S, existing) {
    if (existing) return sortedMasks.str
    const arr = sortedMasks.arr
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cmpMask(arr[mid], S) < 0) lo = mid + 1; else hi = mid
    }
    const s36 = S.toString(36)
    const parts = sortedMasks.strs.slice()
    parts.splice(lo, 0, s36)
    return parts.join('|')
  }

  function rec1(remain, F) {
    if (remain === 0) return new Map([[0n, { cost: 0n, count: 1n }]])
    const k = stateKey(remain, F)
    const cached = memo1.get(k)
    if (cached !== undefined) return cached

    let pick = -1, pickEst = Infinity
    for (let ci = 0; ci < L; ci++) {
      if (!(remain & (1 << ci))) continue
      const e = estimateCount(ci, F)
      if (e === 0) {
        memo1.set(k, new Map())
        nodes.set(k, { remain, pick: -1, edges: [] })
        return new Map()
      }
      if (e < pickEst || (e === pickEst && popcount(lU[ci]) > popcount(lU[pick]))) {
        pick = ci; pickEst = e
      }
    }
    const opts = optionsFor(pick, F)
    opts.sort(optCmp)

    // 本状态非根掩码的规范序（供 O(?) 拼子键，避免每选项重新排序）
    const arrM = F.m.slice(1)
    arrM.sort((a, b) => cmpMask(a, b))
    const sortedMasks = { arr: arrM, strs: arrM.map((x) => x.toString(36)), str: arrM.map((x) => x.toString(36)).join('|') }
    const nextRemain = remain & ~(1 << pick)
    const nextHead = nextRemain.toString(36)

    const out = new Map()
    const edges = []
    for (const o of opts) {
      const maskPart = maskSuffixInsert(sortedMasks, o.S, o.existing)
      const childKey = maskPart.length ? `${nextHead}|${maskPart}` : nextHead
      const dr = deltaOf(o.s)
      let sub
      if (nextRemain === 0) {
        sub = new Map([[0n, { cost: 0n, count: 1n }]])
      } else {
        const hit = memo1.get(childKey)
        if (hit !== undefined) {
          sub = hit // 同构森林已算过：无需克隆
        } else {
          const nf = o.existing ? F : cloneInsert(F, o)
          sub = rec1(nextRemain, nf)
        }
      }
      edges.push({ o, ck: childKey, dr, pick, nextRemain })
      for (const [sig, se] of sub) {
        const ns = sigAdvance(sig, dr.d, dr.rows, caps)
        if (ns === null) continue
        // ns 覆盖 remain 全部列；加上其补集列的最大贡献仍达不到有效下界则必废
        if (!canReachFloor(ns, remain)) continue
        const cost = o.cost + se.cost
        const cur = out.get(ns)
        if (cur === undefined) out.set(ns, { cost, count: se.count })
        else if (cost < cur.cost) { cur.cost = cost; cur.count = se.count }
        else if (cost === cur.cost) cur.count += se.count
      }
    }
    nodes.set(k, { remain, pick, edges })
    memo1.set(k, out)
    return out
  }

  const single = L === 1
  let rootMap, singleLayers
  if (single) {
    singleLayers = buildSingle()
    rootMap = singleLayers.length === 0
      ? new Map([[0n, { cost: 0n, count: 1n }]])
      : singleLayers[singleLayers.length - 1]
  } else {
    rootMap = rec1(ALLCOLS, makeForest())
  }
  if (rootMap.size === 0) return null

  const zeroOnes = () => new Array(K).fill(0n)
  const rootF = makeForest()
  const rootKey = stateKey(ALLCOLS, rootF)

  // —— 第 2 遍：只为目标签名集构建 {count, ones, canon} ——
  function buildDetails(targetSet) {
    if (single) return buildDetailsSingle(targetSet)
    return buildDetailsMulti(targetSet)
  }

  // 多列：先沿第 1 遍记录的贡献边把目标签名自顶向下传播为子状态需求
  // （工作列表求并集，正确处理多个父状态共享同一子状态），再按 remain 列数
  // 升序自底向上聚合计数、取 1 次数与规范代表。
  function buildDetailsMulti(targetSet) {
    const leafDetail = new Map([[0n, { count: 1n, ones: zeroOnes(), canon: new Int8Array(K).fill(-1) }]])

    // —— 需求传播 ——
    const need = new Map([[rootKey, new Set(targetSet)]])
    const queue = [rootKey]
    while (queue.length) {
      const k = queue.shift()
      const node = nodes.get(k)
      if (!node || node.pick === -1) continue
      const targets = need.get(k)
      const parentLight = memo1.get(k)
      for (const T of targets) {
        for (const { o, ck, dr, nextRemain } of node.edges) {
          const cs = sigRetreat(T, dr.d, dr.rows)
          if (cs === null) continue
          const childCost = nextRemain === 0
            ? (cs === 0n ? 0n : null)
            : memo1.get(ck)?.get(cs)?.cost
          if (childCost === null || childCost === undefined) continue
          if (childCost + o.cost !== parentLight.get(T).cost) continue
          let set = need.get(ck)
          if (!set) { set = new Set(); need.set(ck, set) }
          if (!set.has(cs)) { set.add(cs); queue.push(ck) }
        }
      }
    }

    // —— 自底向上聚合（子状态 remain 更少，先处理） ——
    const detail = new Map()
    const ordered = [...need.keys()]
      .filter((k) => k !== rootKey && nodes.has(k))
      .sort((a, b) => remainCountOf(a) - remainCountOf(b))
    for (const k of ordered) aggregate(k)
    return aggregate(rootKey)

    function aggregate(k) {
      const node = nodes.get(k)
      const out = new Map()
      if (!node || node.pick === -1) { detail.set(k, out); return out }
      const parentLight = memo1.get(k)
      for (const T of need.get(k) ?? []) {
        let count = 0n
        const ones = zeroOnes()
        let canon = null
        for (const { o, ck, dr, pick, nextRemain } of node.edges) {
          const cs = sigRetreat(T, dr.d, dr.rows)
          if (cs === null) continue
          const sd = nextRemain === 0
            ? (cs === 0n ? leafDetail.get(0n) : null)
            : detail.get(ck)?.get(cs) ?? null
          if (!sd) continue
          const childCost = nextRemain === 0 ? 0n : memo1.get(ck).get(cs).cost
          if (childCost + o.cost !== parentLight.get(T).cost) continue
          count += sd.count
          for (const g of globalIndices) ones[g] += sd.ones[g]
          const cand = sd.canon.slice()
          let x = lU[pick]
          while (x) {
            const b = x & -x
            x ^= b
            const r = rowOfBit(b)
            const g = E_cellIndex(ctx, r, cols[pick])
            cand[g] = (o.s & b) ? 1 : 0
            if (o.s & b) ones[g] += sd.count
          }
          if (canon === null || canonLessAt(cand, canon, orderedG)) canon = cand
        }
        if (count > 0n) out.set(T, { count, ones, canon })
      }
      detail.set(k, out)
      return out
    }
  }


  // 单列：前向携带 ones/canon，并用“必须能到达某个目标”反向剪枝
  function buildDetailsSingle(targetSet) {
    // 无问号单列：唯一空签名，细节平凡
    if (singleLayers.length === 0) {
      return new Map([[0n, { count: 1n, ones: zeroOnes(), canon: new Int8Array(K).fill(-1) }]])
    }
    // 反向可达签名集（每一层）：back[i] = 第 i 个问号折叠后可抵达目标的签名集
    const last = singleLayers.length - 1
    const back = new Array(singleLayers.length)
    back[last] = new Set(targetSet)
    for (let i = last; i >= 1; i--) {
      const g = orderedG[i]
      const u = E.varByGlobal.get(g)
      const reach = new Set()
      for (const T of back[i]) {
        // val=0 前缀
        if (singleLayers[i - 1].has(T)) reach.add(T)
        // val=1 前缀：对应行 nibble 减 1
        const r = u.r
        if (sigNib(T, r) >= 1) {
          const pre = T - (1n << (BigInt(r) * NIB_BITS))
          if (singleLayers[i - 1].has(pre)) reach.add(pre)
        }
      }
      back[i - 1] = reach
    }

    let dp = new Map([[0n, {
      count: 1n, ones: zeroOnes(), canon: new Int8Array(K).fill(-1), cost: 0n,
    }]])
    for (let i = 0; i < orderedG.length; i++) {
      const g = orderedG[i]
      const u = E.varByGlobal.get(g)
      const layer = singleLayers[i]
      const reach = back[i]
      const nextDp = new Map()
      for (const [sig, de] of dp) {
        for (const val of [0, 1]) {
          let ns = sig
          if (val) {
            if (sigNib(sig, u.r) >= caps[u.r]) continue
            ns = sig + (1n << (BigInt(u.r) * NIB_BITS))
          }
          if (!reach.has(ns)) continue
          const cost = de.cost + (val ? u.c1 : u.c0)
          if (layer.get(ns).cost !== cost) continue
          const ones = de.ones.slice()
          if (val) ones[g] += de.count
          const canon = de.canon.slice()
          canon[g] = val
          const cur = nextDp.get(ns)
          if (cur === undefined) nextDp.set(ns, { count: de.count, ones, canon, cost })
          else if (cost === cur.cost) {
            cur.count += de.count
            for (const gg of globalIndices) cur.ones[gg] += ones[gg]
            if (canonLessAt(canon, cur.canon, orderedG)) cur.canon = canon
          }
        }
      }
      dp = nextDp
    }
    const out = new Map()
    for (const T of targetSet) {
      const d = dp.get(T)
      if (d) out.set(T, { count: d.count, ones: d.ones, canon: d.canon })
    }
    return out
  }

  function remainCountOf(k) {
    const head = BigInt(parseInt(k.split(',')[0], 36))
    let c = 0n, x = head
    while (x) { x &= x - 1n; c++ }
    return Number(c)
  }

  return {
    globalIndices,
    light: rootMap,
    buildDetails,
  }
}

function E_cellIndex(ctx, r, c) {
  return ctx.cellIndex[r][c]
}

// 各分量负荷剖面的稀疏卷积合并（两遍：轻量卷积定最优签名，再仅沿胜出签名
// 收集细节）。行支撑两两不交的分量组成“超级组”：逐行负荷下它们完全独立，
// 各组分别最优，代价相加、计数相乘、规范代表直接拼接。
function mergeLoadProfiles(profiles, ctx) {
  const { n, loads, fixedOneCnt } = ctx
  const K = ctx.nUnknowns

  // 超级组已在 solve() 中按行支撑相交图分解好（并用于分量 DP 的下界剪枝）
  const superGroups = ctx.superGroups


  let optimumCost = 0n
  let optimumCount = 1n
  const chosen = new Int8Array(K).fill(-1)
  const onesAmongOpt = new Array(K).fill(0n)
  const groupResults = []

  for (const members of superGroups) {
    const g = mergeGroup(members.map((i) => profiles[i]), ctx)
    if (g === null) return null
    groupResults.push(g)
    optimumCost += g.optimumCost
    optimumCount *= g.optimumCount
  }
  // 跨超级组：组内取 1 次数乘以其余组最优计数之积；规范代表拼接（变量集合互斥）
  groupResults.forEach((g) => {
    const other = optimumCount / g.optimumCount
    for (let k = 0; k < K; k++) {
      if (g.chosen[k] !== -1) chosen[k] = g.chosen[k]
      onesAmongOpt[k] += g.rawOnes[k] * other
    }
  })
  return { optimumCost, optimumCount, chosen: chosen.slice(), onesAmongOpt }
}

// 一个超级组内：这些分量的行支撑可能重叠，必须稀疏卷积联合。
function mergeGroup(groupProfiles, ctx) {
  const { n, loads, fixedOneCnt } = ctx
  const K = ctx.nUnknowns

  // 本组问号涉及的细胞行集合（不同超级组的行集合两两不交；区间只需也只能
  // 在这些行上被满足——不属于任何组的行没有问号，其可行性已在输入冲突阶段判定）。
  const groupRows = new Uint8Array(n)
  for (const prof of groupProfiles)
    for (const g of prof.globalIndices) groupRows[ctx.rowOfGlobal[g]] = 1

  // 每行每分量问号容量（下界剪枝用）
  const rowCap = groupProfiles.map((prof) => {
    const a = new Int16Array(n)
    for (const g of prof.globalIndices) a[ctx.rowOfGlobal[g]]++
    return a
  })
  const suffixMax = new Array(groupProfiles.length + 1)
  suffixMax[groupProfiles.length] = new Int16Array(n)
  for (let i = groupProfiles.length - 1; i >= 0; i--) {
    suffixMax[i] = suffixMax[i + 1].map((v, r) => v + rowCap[i][r])
  }

  // 最终判定只针对本组行：它们的负荷不会被其他超级组改变
  const sigFinalOK = (sig) => {
    for (let r = 0; r < n; r++) {
      if (!groupRows[r]) continue
      const load = fixedOneCnt[r] + sigNib(sig, r)
      if (BigInt(load) < loads[r].lo || BigInt(load) > loads[r].hi) return false
    }
    return true
  }
  const prune = (sig, i) => {
    for (let r = 0; r < n; r++) {
      const v = sigNib(sig, r)
      // 全局硬上界：任何组都不能使某行超限（非本组行 v=0，检查退化为固定 1 ≤ hi）
      if (fixedOneCnt[r] + v > Number(loads[r].hi)) return false
      // 下界剪枝只对本组行有效：其他行由别的超级组补足
      if (groupRows[r] && fixedOneCnt[r] + v + suffixMax[i][r] < Number(loads[r].lo)) return false
    }
    return true
  }

  // —— 第 1 遍：轻量正向卷积，保留每层签名档 ——
  const layers = [new Map([[0n, { cost: 0n, count: 1n }]])]
  for (let i = 0; i < groupProfiles.length; i++) {
    const prof = groupProfiles[i]
    const next = new Map()
    for (const [psig, pe] of layers[i]) {
      for (const [qsig, qe] of prof.light) {
        const ns = psig + qsig
        if (!prune(ns, i + 1)) continue
        const cost = pe.cost + qe.cost
        const cur = next.get(ns)
        if (cur === undefined) next.set(ns, { cost, count: pe.count * qe.count })
        else if (cost < cur.cost) { cur.cost = cost; cur.count = pe.count * qe.count }
        else if (cost === cur.cost) cur.count += pe.count * qe.count
      }
    }
    layers.push(next)
    if (next.size === 0) return null
  }

  // 胜出总签名集合（可行且全局最优代价）
  let bestCost = null
  for (const [sig, e] of layers[layers.length - 1]) {
    if (!sigFinalOK(sig)) continue
    if (bestCost === null || e.cost < bestCost) bestCost = e.cost
  }
  if (bestCost === null) return null
  const winSet = new Set()
  for (const [sig, e] of layers[layers.length - 1]) {
    if (sigFinalOK(sig) && e.cost === bestCost) winSet.add(sig)
  }

  // —— 反向：每层能扩展到胜出签名的精确可达签名集 ——
  const reach = new Array(layers.length)
  reach[layers.length - 1] = winSet
  const profTargets = new Array(groupProfiles.length)
  for (let i = groupProfiles.length - 1; i >= 0; i--) {
    const back = new Set()
    const tset = new Set()
    for (const T of reach[i + 1]) {
      for (const [psig] of layers[i]) {
        for (const [qsig] of groupProfiles[i].light) {
          if (psig + qsig !== T) continue
          back.add(psig)
          tset.add(qsig)
        }
      }
    }
    reach[i] = back
    profTargets[i] = tset
  }

  // —— 第 2 遍：各分量仅为目标签名构建细节 ——
  const details = groupProfiles.map((prof, i) => prof.buildDetails(profTargets[i]))

  // —— 带细节的正向卷积，仅在可达窄带内展开 ——
  const canonOrder = Array.from({ length: K }, (_, g) => g)
  let detLayer = new Map([[0n, {
    count: 1n, ones: new Array(K).fill(0n), canon: new Int8Array(K).fill(-1),
  }]])
  for (let i = 0; i < groupProfiles.length; i++) {
    const prof = groupProfiles[i]
    const next = new Map()
    for (const [psig, pe] of detLayer) {
      if (!reach[i].has(psig)) continue
      for (const [qsig] of prof.light) {
        const ns = psig + qsig
        if (!reach[i + 1].has(ns)) continue
        const qd = details[i].get(qsig)
        if (!qd) continue
        // 必须命中轻量层该签名的最优代价档
        if (layers[i].get(psig).cost + prof.light.get(qsig).cost !== layers[i + 1].get(ns).cost) continue
        const count = pe.count * qd.count
        const ones = new Array(K).fill(0n)
        for (let k = 0; k < K; k++) {
          ones[k] = pe.ones[k] * qd.count + qd.ones[k] * pe.count
        }
        const canon = pe.canon.slice()
        for (const g of prof.globalIndices) canon[g] = qd.canon[g]
        const cur = next.get(ns)
        if (cur === undefined) next.set(ns, { count, ones, canon })
        else {
          cur.count += count
          for (let k = 0; k < K; k++) cur.ones[k] += ones[k]
          if (canonLessAt(canon, cur.canon, canonOrder)) cur.canon = canon
        }
      }
    }
    detLayer = next
  }

  // 胜出签名（互相同代价）再聚合一次
  let count = 0n
  const rawOnes = new Array(K).fill(0n)
  let canon = null
  for (const T of winSet) {
    const d = detLayer.get(T)
    if (!d) continue
    count += d.count
    for (let k = 0; k < K; k++) rawOnes[k] += d.ones[k]
    if (canon === null || canonLessAt(d.canon, canon, canonOrder)) canon = d.canon
  }
  return { optimumCost: bestCost, optimumCount: count, chosen: canon.slice(), rawOnes }
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
