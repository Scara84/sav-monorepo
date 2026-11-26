import { checkKdrive } from '../api/_lib/clients/kdrive'

async function main() {
  try {
    process.loadEnvFile('.env.local')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Configuration — lecture de .env.local impossible.')
      process.exitCode = 1
      return
    }
  }

  const { ok, messages } = await checkKdrive(process.env)
  for (const line of messages) console.log(line)
  if (!ok) process.exitCode = 1
}

void main()
