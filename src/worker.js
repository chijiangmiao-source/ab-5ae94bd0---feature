// Web Worker：在后台线程执行精确求解，避免阻塞浏览器 UI。
// 消息：{ id, input }；回传：{ id, ok:true, result } 或 { id, ok:false, message, stack }
import { solve } from './solver.js'

function serialize(result) {
  // optimumCost / optimumCount 为 BigInt（任意精度），序列化为十进制字符串
  if (result && typeof result === 'object' && 'optimumCost' in result) {
    return {
      ...result,
      optimumCost: result.optimumCost.toString(),
      optimumCount: result.optimumCount.toString(),
    }
  }
  return result
}

self.onmessage = (e) => {
  const { id, input } = e.data || {}
  try {
    const result = serialize(solve(input))
    self.postMessage({ id, ok: true, result })
  } catch (err) {
    self.postMessage({ id, ok: false, message: String(err && err.message || err), stack: String(err && err.stack || '') })
  }
}
