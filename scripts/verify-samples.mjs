// verify 专用：对“固定歧义”与“固定冲突”两个样例做显式断言——
// 核对最优补全数、规范补全矩阵、问号裁决，以及冲突突变对与三项细胞见证。
// 全部通过则退出码 0，否则 1。
import { solve } from '../src/solver.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    console.error(`  ✗ ${msg}`)
    failures++
  }
}

console.log('样例 A：固定歧义（同优可变）')
{
  const matrix = [
    [1, 0, -1],
    [-1, 0, 0],
    [0, 1, -1],
    [0, -1, 0],
  ]
  const costs = [
    { c0: 5, c1: 5 }, // (0,2)
    { c0: 9, c1: 1 }, // (1,0)
    { c0: 2, c1: 2 }, // (2,2)
    { c0: 0, c1: 7 }, // (3,1)
  ]
  const res = solve({ matrix, costs })
  assert(res.status === 'ok', `求解成功（实际：${res.status}）`)
  assert(res.optimumCost === 8n, `最优总代价 = 8（实际：${res.optimumCost}）`)
  assert(res.optimumCount === 3n, `最优补全数 = 3（实际：${res.optimumCount}）`)
  const expectedCanonical = [
    [1, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 0],
  ]
  assert(JSON.stringify(res.matrix) === JSON.stringify(expectedCanonical),
    `规范补全矩阵正确（实际：${JSON.stringify(res.matrix)}）`)
  const kind = (r, c) => res.calls.find((x) => x.r === r && x.c === c).kind
  assert(kind(0, 2) === 'free', '(0,2) 为同优可变')
  assert(kind(2, 2) === 'free', '(2,2) 为同优可变')
  assert(kind(1, 0) === 'fixed1', '(1,0) 为固定 1')
  assert(kind(3, 1) === 'fixed0', '(3,1) 为固定 0')
}

console.log('样例 B：固定数据三配型冲突')
{
  const matrix = [
    [1, 1, 0], // 11 见证
    [1, 0, 0], // 10 见证
    [0, 1, 1], // 01 见证
    [0, 0, 0],
  ]
  const res = solve({ matrix, costs: [] })
  assert(res.status === 'conflict', `识别为冲突（实际：${res.status}）`)
  assert(res.conflicts.length === 1, `冲突突变对数 = 1（实际：${res.conflicts.length}）`)
  const cf = res.conflicts[0]
  assert(cf.a === 0 && cf.b === 1, `冲突对为 M1 × M2（实际：M${cf.a + 1} × M${cf.b + 1}）`)
  assert(JSON.stringify(cf.p11) === JSON.stringify([0]), `11 见证 = C1（实际：${cf.p11.map((r) => r + 1)}）`)
  assert(JSON.stringify(cf.p10) === JSON.stringify([1]), `10 见证 = C2（实际：${cf.p10.map((r) => r + 1)}）`)
  assert(JSON.stringify(cf.p01) === JSON.stringify([2]), `01 见证 = C3（实际：${cf.p01.map((r) => r + 1)}）`)
}

console.log('样例 C：任意精度计数（不相交列上的对称代价 → 2^k）')
{
  const matrix = [
    [1, 0, -1],
    [0, 0, -1],
    [0, 1, -1],
    [0, 0, -1],
  ]
  const costs = Array.from({ length: 4 }, () => ({ c0: '0', c1: '0' }))
  const res = solve({ matrix, costs })
  assert(res.status === 'ok', `求解成功（实际：${res.status}）`)
  assert(res.optimumCount === 16n, `补全数 = 2^4 = 16（实际：${res.optimumCount}）`)
}

if (failures) {
  console.error(`\nverify 样例核对失败：${failures} 项`)
  process.exit(1)
}
console.log('\n全部 verify 样例核对通过。')
