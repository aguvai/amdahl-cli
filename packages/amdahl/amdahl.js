#!/usr/bin/env node
// The `amdahl` package: `npx amdahl ...` runs @amdahl/cli, pinned to the same
// version, exactly as `npx @amdahl/cli ...` does. The CLI reads process.argv
// itself, so loading its bin is the whole job.
import '@amdahl/cli/dist/amdahl.js'
