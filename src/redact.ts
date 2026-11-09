/** Strip km_ tokens and the active key from any text, including multi-line text. */
export function redactSecret(text: string, secret?: string): string {
  let out = text.replace(/km_[A-Za-z0-9_.-]+/g, '***')
  if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('***')
  return out
}
