#!/usr/bin/env node
// The `amdahl` package: `npx amdahl ...` runs @amdahl/cli, pinned to the same
// version, exactly as `npx @amdahl/cli ...` does. It loads the CLI's own
// launcher, which checks the Node.js version before the CLI itself loads
// and reads process.argv, so loading it is the whole job.
import '@amdahl/cli/bin/amdahl.js'
