# Milestone 3 Dependency Security Report

**Audit date:** 2026-11-03  
**Runtime:** Node.js 20.20.2, npm 10.8.2

## Result

The final root `npm audit` reports **18 advisories: 3 critical, 7 high, and 8 moderate**. These are in the CAP development-tool dependency tree; the direct vulnerable package is development dependency `@sap/cds-dk`. Root `npm audit --omit=dev` reports **0 vulnerabilities**.

The separately locked App Router module uses `@sap/approuter` **23.4.0** and its `npm audit --prefix approuter` reports **0 vulnerabilities**. Version 23.4.0 requires Node.js 22 or 24, so the App Router deployment runtime must use one of those versions. This differs from the local validation host (Node.js 20.20.2); no App Router runtime/login test was possible locally.

The remaining findings still matter to developer and build environments. Do not treat clean production or App Router audits as a clean root development-tool audit.

## Vulnerable packages

| Severity | Package | Direct? | Installed dependency path / issue |
|---|---|---:|---|
| Critical | `@sap/cds-mtxs` | No | Nested under `@sap/cds-dk`; credential disclosure advisory [GHSA-955m-rr6m-2f9v](https://github.com/advisories/GHSA-955m-rr6m-2f9v). |
| Critical | `handlebars` | No | Nested under `@sap/cds-dk`; three reported template-compilation/injection advisories. |
| Critical | `proxy-addr` | No | Nested under `@sap/cds-dk`; IPv4-mapped IPv6 trust-subnet spoofing advisory [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h). |
| High | `axios` | No | Nested under `@sap/cds-dk`; multiple proxy, redirect, prototype-pollution, header, and denial-of-service advisories. |
| High | `body-parser` | No | Nested under `@sap/cds-dk`; request parsing denial-of-service advisories. |
| High | `brace-expansion` | No | Nested under `@sap/cds-dk`; expansion/recursion denial-of-service advisories. |
| High | `follow-redirects` | No | Nested under `@sap/cds-dk`; sensitive-header/credential handling on redirects. |
| High | `form-data` | No | Nested under `@sap/cds-dk`; multipart field/filename CRLF injection advisory. |
| High | `js-yaml` | No | Nested under `@sap/cds-dk`; merge/alias parsing denial-of-service advisories. |
| High | `ws` | No | Nested under `@sap/cds-dk`; memory disclosure and denial-of-service advisories. |
| Moderate | `@eslint-community/eslint-utils` | No | Nested under `@sap/cds-dk`; inherited from the ESLint toolchain. |
| Moderate | `@eslint/config-array` | No | Nested under `@sap/cds-dk`; inherited from the ESLint toolchain. |
| Moderate | `@eslint/eslintrc` | No | Nested under `@sap/cds-dk`; inherited from the ESLint toolchain. |
| Moderate | `@sap/cds-dk` | **Yes (dev)** | Installed 8.9.19; npm reports the available remediation as 10.2.0, a major upgrade. |
| Moderate | `@sap/eslint-plugin-cds` | No | Nested under `@sap/cds-dk`. |
| Moderate | `eslint` | No | Nested under `@sap/cds-dk`; npm reports the toolchain major upgrade as the fix. |
| Moderate | `minimatch` | No | Nested under `@sap/cds-dk`; npm reports the toolchain major upgrade as the fix. |
| Moderate | `qs` | No | Nested under `@sap/cds-dk`; query-string denial-of-service advisories. |

## Remediation decision

- Ran `npm audit fix` without `--force`. npm made **no dependency or lockfile updates** and exited with advisories still present.
- Ran `npm audit fix --dry-run`; it also reported no changes.
- The direct CAP development-kit remediation offered by npm is `@sap/cds-dk@10.2.0`, a major upgrade from the current CAP 8 toolchain. The installed `@sap/cds` is 8.9.10. Jumping only the CLI major, forcing upgrades, or pinning transitive packages without a CAP compatibility review would be unsafe.
- Registry checks confirmed these advisory patch releases exist: `@sap/cds-mtxs@2.7.7`, `axios@1.20.0`, `body-parser@1.20.9`, `brace-expansion@1.1.21`, `follow-redirects@1.16.2`, `form-data@4.0.6`, `handlebars@4.7.10`, `js-yaml@4.3.2`, `proxy-addr@2.0.8`, `qs@6.16.1`, and `ws@8.21.0`. These are candidate transitive versions, not validated CAP 8 overrides; npm's supported non-force remediation left the lockfile unchanged. The remaining ESLint/minimatch findings are reported as resolved by the CAP development-kit major upgrade.
- `npm outdated` also shows newer major versions for CAP adapters/runtime, dotenv, Express, and `pdf-parse`; those are not applied as opportunistic updates.
- The vulnerable App Router 20.x dependency was upgraded in its own deployment module to 23.4.0, with its own lockfile; its isolated audit is clean. This requires Node.js 22 or 24 for the router process.
- The root CAP development-tool advisories remain. No force upgrade of the CAP CLI was applied because the reported root remediation is a major version change and requires CAP 8 compatibility review.

**Recommendation:** schedule a dedicated CAP stack upgrade. Update and validate `@sap/cds`, `@sap/cds-dk`, CAP database adapters, and dependent packages together; then review all audit advisories again and rerun the full suite. If considering transitive overrides before that, test the exact dependency tree and CAP build/runtime paths first. Until then, keep developer tooling out of runtime artifacts and restrict builds to trusted environments.

## Reproduction

```powershell
npm.cmd audit
npm.cmd audit --omit=dev
npm.cmd audit --prefix approuter
npm.cmd test
```

Root `npm audit` exits nonzero because the 18 development-tool advisories remain. Root production and isolated App Router audits report zero vulnerabilities. The App Router requires Node.js 22 or 24 and was not executed under the local Node.js 20 host.
