/* 词斩 WordSlash — Service Worker
 * 策略：
 *  - 导航（页面）：网络优先，离线回退缓存的入口页
 *  - 静态资源：缓存优先 + 后台更新（stale-while-revalidate）
 *  - OCR 资源（tessdata/tesseract）：体积达数十 MB，不写入离线缓存，
 *    交由浏览器 HTTP 缓存处理，避免撑爆 Cache Storage 配额
 *  - 仅处理同源 GET，不干扰接口请求
 *
 * 路径全部相对 SW 作用域（self.registration.scope），兼容部署在子路径（如 GitHub Pages）。
 */
const CACHE_NAME = 'wordslash-pwa-v5'

/** 缓存条目上限：超出后淘汰最旧的条目，避免长期使用后缓存无限膨胀 */
const MAX_ENTRIES = 120

/** SW 作用域前缀（如 https://user.github.io/wordslash/），用于拼绝对路径缓存键 */
const SCOPE = self.registration.scope

/** 基于作用域的绝对路径，避免相对路径在缓存匹配时产生歧义 */
function scoped(path) {
  return new URL(path.replace(/^\//, ''), SCOPE).toString()
}

const INDEX_URL = scoped('./index.html')
const SKIP_NAMES = ['tessdata', 'tesseract']

// 安装即预缓存的核心资源（入口页 + 图标 + manifest）
const PRECORE = [
  SCOPE,
  INDEX_URL,
  scoped('manifest.webmanifest'),
  scoped('favicon.svg'),
  scoped('icons/icon-192.png'),
  scoped('icons/icon-512.png'),
]

function shouldSkip(url) {
  const parts = url.pathname.split('/')
  return parts.some((p) => SKIP_NAMES.includes(p))
}

/** 淘汰超出上限的旧缓存条目 */
async function trimCache(cache) {
  try {
    const keys = await cache.keys()
    if (keys.length <= MAX_ENTRIES) return
    const excess = keys.length - MAX_ENTRIES
    for (let i = 0; i < excess; i++) await cache.delete(keys[i])
  } catch { /* 忽略清理失败 */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      Promise.all(PRECORE.map((u) => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try { url = new URL(req.url) } catch { return }
  if (url.origin !== self.location.origin) return
  if (shouldSkip(url)) return

  // —— 页面导航：网络优先，离线回退 ——
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(async (resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone()
          const c = await caches.open(CACHE_NAME)
          await c.put(INDEX_URL, copy)
        }
        return resp
      }).catch(async () => {
        const c = await caches.open(CACHE_NAME)
        return (await c.match(INDEX_URL)) || Response.error()
      })
    )
    return
  }

  // —— 静态资源：缓存优先，后台更新 ——
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then(async (resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone()
          const c = await caches.open(CACHE_NAME)
          await c.put(req, copy)
          trimCache(c)
        }
        return resp
      }).catch(() => cached || Response.error())
      return cached || network
    })
  )
})

// 支持页面主动触发更新缓存
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})
