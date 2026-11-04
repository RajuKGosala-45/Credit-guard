# Security Remediation Design

## Design objective

Replace demo trust assumptions with server-verified identity and authorization while preserving the existing business workflow. This is a proposed design only; no source or authentication configuration was changed.

## Approval identity and permission model

### Identity source

1. Authenticate users through the organization's approved identity provider, integrated with CAP's supported production authentication mechanism for the chosen deployment.
2. Derive the principal only from a successfully validated server-side authentication context/token. Do not accept user ID, approver role, or entitlement from request JSON, query parameters, browser storage, or a displayed role selector.
3. Use a configured claim/group mapping owned by the identity administrator. Deny by default when identity or required entitlement is absent, invalid, expired, or ambiguous.
4. For custom Express routes, explicitly verify how the CAP authentication context is propagated to the Express handler. If it is not automatically enforced, place validated auth middleware/authorization checks before protected route handlers; never decode an unverified token or trust a client-supplied claim.

**Reason:** Current `srv/server.js` trusts the submitted `role` and `decidedBy`; README says authentication is mocked.

| Recommendation | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|
| Establish a validated server principal and default-deny role/entitlement mapping. | `srv/server.js`, CAP auth configuration/package config, deployment configuration | Approved identity provider, claim contract, CAP deployment profile | Wrong claim mapping could grant excess rights; unavailable identity provider may reduce availability | Test absent/invalid/expired token, ordinary user, controller, finance role, and unrelated roles; inspect effective server principal. |
| Bind decision actor and role to the authenticated principal; remove body fields as authorization inputs. | `srv/server.js`, `app/credit/js/api.js`, `app/credit/js/views/approvals.js` | Identity mapping and agreed UI behavior | UI could display stale permissions; server remains authoritative | Tamper with `role`/`decidedBy` body values; server must ignore/reject and persist principal identity only. |

## Proposed authorization policy

The policy below is a design baseline requiring business/security-owner approval. It does not assert that these roles already exist in an identity provider.

| Capability | Proposed permission | Guard |
|---|---|---|
| Read portfolio/customer data | Authenticated `CreditReader` or an explicitly approved broader business role | Check server principal; minimize returned fields by use case. |
| List/create a limit request | Authenticated requester role (for example `CreditRequester`) | Validate request; record actual principal as requester; create Pending only. |
| Decide controller-routed request | `CreditController` entitlement | Request must remain Pending; requester must differ from approver; decision and limit update must be atomic. |
| Decide finance-routed request | `FinanceHead` entitlement | Same safeguards; no client-supplied role; enforce routing level. |
| Administer permissions/configuration | Separate operational administrator identity, not an approver permission by default | Out-of-band governed configuration and audit. |
| AI assistant | Read tools under caller's permitted scope; proposal tool may create a Pending request only when policy explicitly allows it | No approve/reject tool, no direct limit update, no approval entitlement, all tool calls pass the same business validation and authorization layer. |

**Reason:** A role hierarchy in `srv/rules.js` only evaluates strings; it does not authenticate a user or authorize access to customer data.

| Recommendation | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|
| Implement server-side permission checks per endpoint and operation; apply least privilege to read/write paths. | `srv/server.js`, `srv/service.cds`, CAP auth configuration | Approved role/permission matrix and principal source | Overly broad read roles or inconsistent REST/OData controls | Matrix-based tests for every endpoint and entity operation; unknown role denies. |
| Enforce separation of duties: request creator cannot approve that request; approver identity must be distinct and authorized for the route level. Decide whether additional dual approval is required by policy. | `srv/server.js`, `db/schema.cds`, `srv/rules.js` | Business owner decision on self-approval and multi-approval | Legitimate emergency flows may be blocked; a missing immutable requester identity weakens enforcement | Test self-approval denial, delegated identities, same-user aliases, and all required escalation paths. |
| Give the AI service/tool identity proposal-only permission; it cannot possess decision entitlements or call decision mutation directly. | `srv/agent.js`, `srv/server.js`, `srv/service.cds`, future service identity configuration | Service-to-service authentication design and agreed AI requester attribution | Shared credentials or overly broad backend service permissions could defeat the boundary | Attempt decision operation with AI identity; expect denial. Verify proposal produces only Pending status and a traceable actor/source. |

## OData and API boundary

Current projections in `srv/service.cds` expose `Customers`, `OpenItems`, and `LimitRequests` without visible restrictions. The source alone does not prove which CRUD operations are reachable under the deployed CAP profile.

1. Treat customer and open-item projections as read-only by default.
2. Treat `LimitRequests` as read-only through generic OData as well; do not allow clients to patch request status or write customer limits directly.
3. If OData writes are required, expose narrowly scoped actions/commands backed by the same domain service and authenticated policy as the REST workflow. Do not use generic entity update permissions for decision control.
4. Apply CAP authorization annotations/handlers appropriate to the verified CAP version, and test the compiled service metadata and runtime methods. An annotation is not a substitute for inspecting effective auth configuration.
5. Restrict create/update/delete for all entities unless the exact operation is approved. Add field-level validation and immutable audit attribution for any explicit command.

**Reason:** Generic OData entity mutation can bypass custom approval logic if enabled.

| Recommendation | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|
| Make data projections read-only and restrict entity access; define a dedicated authorized decision command only if needed. | `srv/service.cds`, `db/schema.cds`, CAP auth config, `srv/server.js` or future domain handlers | CAP version behavior, approved access matrix | Incorrect annotation/handler semantics could block legitimate reads or leave write surface open | Inspect service metadata; attempt GET/POST/PATCH/DELETE with anonymous and each role in a deployment-equivalent test. |
| Route all approved limit changes through a single domain operation with atomic pending-state transition and current-limit concurrency policy. | `srv/server.js`, `srv/rules.js`, `db/schema.cds` | Database transaction/isolation support; stale-request policy | Locking/contention; migration of existing request semantics | Concurrent approve/reject and same-customer tests; verify one decision, no lost update, no success-shaped response on zero-row update. |
| Apply consistent payload validation and safe error responses to REST/OData/tool entry points. | `srv/server.js`, `srv/agent.js`, `srv/service.cds`, `db/schema.cds` | Schema contract and validation standards | Breaking existing clients when enforcing bounds | Contract tests for types, max lengths, decimals, status enums, and sanitized failures. |

## Audit, logging, and operational controls

- Record actor subject, effective permission, request ID, operation, target request/customer, outcome, and timestamp in an access-controlled durable audit store.
- Do not log access tokens, provider secrets, full uploaded document text, or unredacted sensitive payloads.
- Return stable, sanitized error responses; record internal diagnostic details with a correlation ID and appropriate redaction.
- Define retention, access, and tamper-resistance requirements with compliance owners.
- Add rate/concurrency limits to expensive chat/document and mutation paths at the application or trusted edge; keep the upload-size bound and add aggregate resource budgets.
- Validate provider/data-egress policy before sending any customer or document data to an external model.

| Recommendation | Affected files | Dependencies | Risks | Validation |
|---|---|---|---|---|
| Add auditable decision events and structured redacted server logs. | `srv/server.js`, `db/schema.cds` or separate approved audit store, deployment logging config | Retention/access policy, persistent storage choice | Sensitive data over-logging; audit store availability | Inspect logs and audit rows for each decision; verify actor, outcome, correlation, access controls, and secret absence. |
| Add resource controls and provider-egress policy. | `srv/server.js`, `srv/documents.js`, `srv/agent.js`, deployment edge/config | Traffic profile, provider/privacy approval | Excessively strict limits degrade legitimate usage; bypass if only edge control is configured incorrectly | Burst/load tests, maximum upload concurrency, provider-offline test, and confirmation that denied data never leaves approved boundary. |

## Critical security tests before modernization

These are release gates, not optional post-release checks:

1. Anonymous and ordinary user cannot approve, reject, mutate credit limits, or read unauthorized records.
2. Editing the frontend request body cannot grant a role or change decision attribution.
3. Requesters, including the AI service identity, cannot approve their own proposals.
4. Direct OData create/update/delete cannot bypass the decision workflow.
5. Concurrent decisions and stale requests cannot create duplicate or lost state transitions.
6. API errors/logs do not expose secrets, stack traces, SQL, file paths, document contents, or provider internals.
7. Identity failure and unknown roles fail closed.
