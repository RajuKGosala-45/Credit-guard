# Security and Authorization

## Identity and roles

The development CAP profile uses named mock identities. The mock provider does not validate passwords and must not be used as production authentication. Custom API routes require a CAP identity and check server-derived roles. Approval actor IDs and permissions are taken from the authenticated identity rather than trusted from request fields.

The XSUAA descriptor defines role templates for reader, requester, analyst, manager, approver, and administrator use. Production startup requires the production profile, HANA, XSUAA, ABAP source configuration, and HANA/XSUAA/Destination service bindings. Configuration tests verify guards; they do not prove deployed SSO, JWT propagation, role assignment, or live identity behavior.

## Approval safeguards

- Request creation requires `CreditRequester`.
- Decisions require an authorized controller/finance-level role consistent with the server-calculated route.
- The request creator cannot approve or reject the same request.
- Decision state and audit history are written transactionally.
- The agent can prepare a proposal, but cannot decide it or directly change a limit.
- CAP OData projections require `CreditReader` and are read-only.

These are application controls; operational role-collection assignment and production identity mapping still require deployment validation.

## Secrets and local data

- Keep local credentials in an untracked `.env` file or managed secret service.
- `.env.example` contains only blank/placeholder configuration, never a credential.
- Never expose provider or SAP credentials to browser code, logs, or source control.
- Local SQLite files and generated output are ignored by Git.
- The local database and synthetic customer fixtures are not a production data store.

## LLM and documents

Without a provider key, the assistant uses offline demo mode. With an Anthropic key configured, chat prompts and extracted document text may be sent to Anthropic. Uploads are in-memory only, with a 10 MiB file limit and 20,000-character analysis limit. Do not upload confidential or regulated data without the required provider, privacy, and retention approvals.

## Repository security review

The repository history was scanned for common private-key, API-token, cloud-key, JWT, and credential-assignment signatures. No high-confidence credential match was found in the reviewed history. Pattern scanning cannot prove the absence of every secret format. If a credential is ever discovered, rotate/revoke it first and assess historical exposure; do not rewrite remote history without explicit authorization.

## Remaining work before production

Validate deployed XSUAA identity propagation, role collections, App Router session/logout and CSRF behavior, error/log redaction, service-binding permissions, rate and resource limits, HANA audit integrity, backup/restore, and operational incident procedures.
