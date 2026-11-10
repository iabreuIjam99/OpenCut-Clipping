export type TurnstileVerifier = (token: string | null, remoteIp: string | null) => Promise<boolean>

export function createTurnstileVerifier(options: {
  secret: string
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}): TurnstileVerifier {
  const secret = options.secret
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000

  return async (token: string | null, remoteIp: string | null): Promise<boolean> => {
    if (!token) {
      return false
    }

    const aborter = AbortSignal.timeout(timeoutMs)

    const params = new URLSearchParams()
    params.append("secret", secret)
    params.append("response", token)
    if (remoteIp) {
      params.append("remoteip", remoteIp)
    }

    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: aborter,
      body: params,
    }

    try {
      const response = await fetchImpl(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        init,
      )

      if (!response.ok) {
        return false
      }

      const data: unknown = await response.json()
      if (typeof data !== "object" || data === null || !("success" in data)) return false
      return data.success === true
    } catch {
      return false
    }
  }
}
