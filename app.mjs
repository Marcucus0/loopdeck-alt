import { start } from './src/server.mjs'

start().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
