#!/usr/bin/env node
import { runCli } from './cli/reset-link.ts'

process.exitCode = runCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
