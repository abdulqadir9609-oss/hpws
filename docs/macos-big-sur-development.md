# macOS Big Sur development notes

This repository uses Cloudflare's local Worker runtime through Wrangler and
`@cloudflare/vitest-plugin`. The current prebuilt `workerd` binary requires
macOS 13.5 or newer, so macOS Big Sur (11.x) cannot run the local Worker
runtime. Downgrading only the top-level `esbuild` package does not solve this:
the Cloudflare Vitest plugin also installs its own `esbuild` dependency, and
the Worker runtime is a separate compatibility requirement.

## What can run on Big Sur

On Big Sur, install the JavaScript packages without running native post-install scripts, then run the TypeScript-only checks. The native esbuild binary cannot execute on this OS, so its install-time validation must be skipped for this limited TypeScript-only workflow:

```bash
npm ci --legacy-peer-deps
npm run check:types
```

The `check:types` script checks the client and server TypeScript projects
without starting Wrangler or `workerd`. `--ignore-scripts` means native build-tool
install scripts are skipped; do not expect esbuild, Wrangler local execution,
or Cloudflare Vitest runtime tests to work on Big Sur.

These commands require a Node.js version supported by the pinned project
toolchain. If dependency installation itself fails on Big Sur, do not run
`npm audit fix --force` or change native package versions blindly; use the
Linux workflow below for the full toolchain.

## Full checks

The following commands use Cloudflare's local runtime and are not supported
by the current `workerd` binary on Big Sur:

```bash
npx vitest run
npm run check
npm run dev
```

Run the full test suite and Wrangler dry-run in the repository's GitHub Actions
workflow (Worker Checks), which runs on Ubuntu. A successful dry-run is not a
production deployment.

## Recommended full-development environment

For full local Worker development, use macOS 13.5 or newer, or a Linux
environment such as GitHub Codespaces. Keep the repository branch and Node.js
version aligned with CI.

Do not use `wrangler dev --remote` against the production Worker as a general
Big Sur workaround. Remote development uploads code to Cloudflare and connects
to remote resources; this project uses Durable Objects and a central device
registry, so testing against production could affect real device sessions and
data. Only consider remote development after a separate staging Worker and
isolated staging resources have been configured.

## Security note

Do not use `npm audit fix --force` to force a Vitest/Cloudflare toolchain
downgrade. The full development-dependency audit currently reports a
`picomatch` advisory in the test/build dependency tree. Production dependency
auditing remains a separate blocking CI check.
