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
 * }
 * 返回 { ok:true, n, m, fixed, unknowns } 或 { ok:false, message }。
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
  return { ok: true, n, m, fixed, unknowns }
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
  const { n, m, fixed, unknowns } = v
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
  let optimumCost = 0n
  let optimumCount = 1n
  const compResults = []
  let feasible = true

  for (const cols of components) {
    const cid = compOf[cols[0]]
    const vars = unknowns.filter((u) => compOf[u.c] === cid)
    const res = solveComponent(cols, vars, { n, f1, f0, U, ALL, cellIndex, nUnknowns: unknowns.length })
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

function solveComponent(cols, vars, ctx) {
  const { n, f1, f0, U, ALL, cellIndex, nUnknowns: K } = ctx
  const L = cols.length
  const lf1 = cols.map((c) => f1[c])
  const lf0 = cols.map((c) => f0[c])
  const lU = cols.map((c) => U[c])
  const varAt = new Map()
  for (const u of vars) varAt.set(`${u.r},${u.c}`, u)
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

  // 两个候选赋值向量（-1=未涉及）按行优先序比较：首个差异处取 0 者小
  function canonLess(a, b) {
    for (const g of orderedG) {
      const x = a[g], y = b[g]
      if (x !== y) return x === 0
    }
    return false
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
      const u = varAt.get(`${rowOfBit(b)},${cols[ci]}`)
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
  greedy(ALLCOLS, makeForest(), 0n)

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
      const take = best === null || total < best || (tie && canonLess(full, bestCanon))
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
