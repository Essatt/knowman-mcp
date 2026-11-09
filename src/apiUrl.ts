export const DEFAULT_API_URL = 'https://api.knowman.io'

export function resolveApiUrl(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return DEFAULT_API_URL
  return trimmed
}
