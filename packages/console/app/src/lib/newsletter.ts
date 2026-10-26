// Printable ASCII without whitespace, exactly one "@", and a dotted domain.
const EMAIL = /^[!-?A-~]{1,64}@[!-?A-~]+\.[!-?A-~]+$/

// Returns the trimmed address when it is safe to send to the newsletter list.
export function newsletterEmail(value: unknown) {
  if (typeof value !== "string") return
  const email = value.trim()
  if (email.length > 254 || !EMAIL.test(email)) return
  return email
}
