import { hashPassword } from '../../api/_lib/auth/password'

async function main(): Promise<void> {
  const [email, forbiddenPasswordArg] = process.argv.slice(2)
  if (forbiddenPasswordArg !== undefined) {
    console.error('Refusing password from argv. Use OPERATOR_PASSWORD instead.')
    process.exit(1)
  }
  const password = process.env['OPERATOR_PASSWORD']
  if (!email || !password) {
    console.error(
      'Usage: OPERATOR_PASSWORD=<secret> npx tsx scripts/security/hash-operator-password.ts <email>'
    )
    process.exit(1)
  }
  const hash = await hashPassword(password)
  const normalizedEmail = email.normalize('NFC').toLowerCase().trim().replace(/'/g, "''")
  const escapedHash = hash.replace(/'/g, "''")
  console.log(`UPDATE public.operators
SET password_hash = '${escapedHash}',
    password_set_at = COALESCE(password_set_at, now()),
    password_updated_at = now()
WHERE email = '${normalizedEmail}'
  AND is_active = true;`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
