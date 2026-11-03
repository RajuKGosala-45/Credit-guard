# Security and Approval Review

## Scope and assumptions

This is a source review of the current demo implementation in `srv/server.js`, `srv/service.cds`, `srv/agent.js`, `srv/documents.js`, and the frontend request/approval modules. The README explicitly states that authentication is mocked and the role selector is not authorization. No production deployment or external network configuration was reviewed.

## Findings

### 1. No trustworthy caller authorization on custom APIs

The Express routes do not perform an identity/permission check. The decision route accepts `role` and `decidedBy` from the JSON body; the UI also submits the selected role. A caller able to reach the endpoint can submit `Finance Head` and decide an eligible pending request. A caller can also read customer and request data and create requests.

- **Classification: Critical risk** for any non-demo deployment.
- The in-code `canDecide` helper checks the claimed role, not the authenticated principal's actual entitlement.
- Do not use the development/demo role selector as production authorization.

### 2. OData entity projections may bypass the custom approval workflow

`srv/service.cds` projects `Customers`, `OpenItems`, and `LimitRequests`; no `@requires`, `@restrict`, or explicit read-only restriction was found. Standard CAP entity handling can expose generic CRUD operations. Depending on effective CAP authentication and deployment configuration, a caller may be able to update a customer's limit directly or alter request state without using the custom decision route.

- **Classification: Critical risk** if the OData service is reachable by untrusted or insufficiently authorized callers.
- **Needs testing:** verify the effective runtime authorization mode and allowed OData methods in the exact deployment configuration.

### 3. Approval decision concurrency and stale requests

The route reads the request as Pending before beginning the transaction. Inside the transaction it updates the customer limit, then updates the request with a `status = 'Pending'` predicate. It does not verify the affected-row count before returning success. Concurrent decisions can therefore race, and multiple pending requests for one customer can each retain an outdated `currentLimit` and later overwrite a newer limit.

- **Classification: Needs improvement** for the transaction/conditional-update design.
- **Classification: Needs testing** with concurrent API requests and multiple pending requests for the same customer.
- This is a **Critical risk** if concurrent decisions can change authoritative production limits.

### 4. Request inputs are only partially constrained

The custom create route validates a present customer, finite positive numeric requested limit, and nonblank reason. It does not explicitly enforce the schema's 500-character reason bound, a monetary scale/precision policy, or a string type for `requestedBy`; non-string values can cause a runtime exception and 500 response. The decision route has similar type assumptions for `decidedBy`.

- **Classification: Needs improvement** for server-side schema validation.
- **Classification: Needs testing** for malformed JSON shapes, maximum lengths, decimals, and values beyond CDS precision.

### 5. Agent-created requests do not share the API's validation path

The `propose_limit_change` tool converts the new limit with `Number` and inserts a request without the route's positive/finite/reason validation. It generates an ID longer than the CDS `String(12)` declaration.

- **Classification: Needs improvement** for consistent authorization and input validation.
- The tool only creates a pending request and does not itself approve or update a customer limit, which is a useful safeguard.
  - **Classification: Verified working** by source review.

### 6. Raw error details are returned to clients

Caught errors are serialized using `error.message` in API responses. There is no corresponding application-level logging or correlation ID in these handlers. Provider/library/database errors may expose internal implementation details, while operational diagnosis remains difficult.

- **Classification: Needs improvement** for error redaction, structured server-side logging, and correlation.

### 7. AI/document data handling

When configured, chat prompts and extracted document text are sent to Anthropic. Uploads are held in memory and not stored; document analysis is not a document verification process. The README warns against uploading sensitive or personal data to the demo.

- **Classification: Critical risk** if confidential/regulated data is sent without an approved provider, retention, privacy, and data-processing review.
- **Classification: Verified working** that the application caps an upload at 10 MiB and extracted text at 20,000 characters, based on source review.
- **Classification: Needs testing** for adversarial/malformed documents, parser resource use, and provider error handling.

### 8. Abuse and resource controls

No application-level rate limiting or request throttling was found for chat, document parsing, or data reads. Upload contents are buffered in memory. The file-count and byte caps are helpful but do not alone bound aggregate concurrent memory or LLM spend.

- **Classification: Needs improvement** before exposure beyond a trusted local demo.
- **Classification: Needs testing** under concurrent uploads and request bursts.

## Approval workflow assessment

### Safeguards present

- Only `Approved` or `Rejected` decisions are accepted.
- A request must exist and be Pending.
- The claimed role must pass the routing hierarchy.
- Approval and request-status updates are grouped in a database transaction.
- AI tool description and implementation create a Pending request only; the tool does not approve it.

- **Classification: Verified working** by source review and the isolated role-hierarchy smoke check.

### Safeguards missing for real authorization

- Authenticated user identity is not bound to `role` or `decidedBy`.
- No server-managed approval permissions, separation of duties, or identity audit evidence is present.
- No protection against concurrent/stale decisions is demonstrated.
- The OData surface may permit direct mutations outside this workflow.

- **Classification: Critical risk** for production approval use.

## Required follow-up validation

1. Verify route access with unauthenticated, ordinary-user, controller, and finance-head identities.
2. Verify OData GET/POST/PATCH/DELETE behavior and authorization in the deployment profile.
3. Race approve/reject requests and approve requests created against an older limit.
4. Confirm errors are not exposing credentials, provider payloads, SQL, file paths, or stack details.
5. Test upload concurrency/resource caps and inspect provider data handling requirements.

All five are **Needs testing**.
