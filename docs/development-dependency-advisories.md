# Development dependency advisory: picomatch ReDoS

## Status (2026-11-17)

The lockfile resolves `picomatch@4.0.7` through the development-only test/build
dependency tree:

`@cloudflare/vitest-plugin` / `vitest` -> `vite` / `tinyglobby` ->
`fdir` -> `picomatch`.

GitHub advisory GHSA-fc5q-39xc-vjpf identifies the lockfile's resolved
`picomatch@4.0.7` as affected by a regular-expression denial-of-service issue
in single-branch repeated extglob patterns. Check the advisory and npm registry
again before remediation; do not assume that a forced downgrade or an
unreviewed fork is a security fix.

## Current project exposure

The affected package is present in `devDependencies` transitively, not in
the production dependency tree. The production-only audit is therefore kept
blocking in CI. The full development dependency audit remains visible in CI
logs and must be revisited when the upstream maintainer publishes a fix.

This does not mean the development dependency tree is vulnerability-free.
Treat CI and local build/test environments as developer-controlled:
- Do not process attacker-controlled glob patterns through this dependency.
- Do not expose development servers or test runners to untrusted networks.
- Keep CI jobs isolated and avoid passing untrusted pull-request input into
  scripts that construct glob patterns.
- Recheck the advisory and rerun the full audit when picomatch publishes a
  patched release.

## Avoid unsafe remediation

Do not run `npm audit fix --force` for this advisory. In this project it
attempted to downgrade Vitest and replace the Cloudflare Vitest plugin with
an invalid version, creating additional vulnerabilities and peer conflicts.
Restore package manifests from version control if that happens, then run
`npm ci` in a supported environment.

## Verification policy

- `npm audit --omit=dev --audit-level=moderate` is a blocking production
  dependency gate.
- `npm audit` is retained as a full-tree report. Known development-only
  advisory findings are not silently treated as fixed.
- Worker functional tests, type checks, and Wrangler dry-run remain required
  CI checks.
