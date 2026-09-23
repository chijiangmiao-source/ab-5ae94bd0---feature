// 生产静态服务器：托管 Vite 构建产物（dist/），提供 /healthz 健康检查。
// 端口通过环境变量 HOST_PORT 配置（默认 8080），HOST 可配置监听地址（默认 0.0.0.0）。
import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.HOST_PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === '/healthz' || pathname === '/health') {
    return send(res, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8')
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed')
  }

  // 静态文件：防路径穿越
  let rel = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(DIST, rel))
  if (!filePath.startsWith(DIST + path.sep) && filePath !== DIST) {
    return send(res, 403, 'Forbidden')
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const type = MIME[path.extname(filePath)] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(filePath).pipe(res)
  }

  // SPA 回退
  const index = path.join(DIST, 'index.html')
  if (existsSync(index)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(index).pipe(res)
  }

  send(res, 503, '构建产物缺失：请先运行 npm run build')
})

server.listen(PORT, HOST, () => {
  const actual = server.address().port
  console.log(`[server] listening on http://${HOST}:${actual} (dist=${DIST})`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
