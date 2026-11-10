import type { Handler } from './types'

interface Route {
  method: string
  regex: RegExp
  keys: string[]
  handler: Handler
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = []
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_m, key: string) => {
      keys.push(key)
      return '([^/]+)'
    })
    this.routes.push({ method, regex: new RegExp(`^${pattern}/?$`), keys, handler })
    return this
  }

  get = (path: string, h: Handler) => this.add('GET', path, h)
  post = (path: string, h: Handler) => this.add('POST', path, h)
  patch = (path: string, h: Handler) => this.add('PATCH', path, h)
  delete = (path: string, h: Handler) => this.add('DELETE', path, h)

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method-not-allowed' | null {
    let pathMatched = false
    for (const route of this.routes) {
      const m = route.regex.exec(pathname)
      if (!m) continue
      pathMatched = true
      if (route.method !== method) continue
      const params: Record<string, string> = {}
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1])
      })
      return { handler: route.handler, params }
    }
    return pathMatched ? 'method-not-allowed' : null
  }
}
