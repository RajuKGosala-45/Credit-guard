# Authentication Validation Results

**Status:** Local configuration and mocked-user authorization tests passed. No BTP XSUAA instance, App Router runtime, signed JWT, or browser SSO flow was available; deployment authentication is not yet validated.

## Verified locally

- Production CAP selects XSUAA and fails closed if the XSUAA service binding is absent.
- Custom API and OData authorization use CAP-authenticated identities and server-derived roles; client-supplied approver/requester roles are not trusted.
- Approval/rejection operations enforce role routing and requester/approver separation. Existing API tests cover anonymous and unauthorized requests.
- `xs-security.json` role templates reference declared scopes and support reader, analyst, manager, approver, and administrator collections.
- The App Router manifest protects application paths with XSUAA authentication and CSRF protection, exposes only the health route without login, and defines logout.
- Cloud Foundry routes App Router traffic to CAP with auth-token forwarding. CAP has local-tested `/health/live` and `/health/ready` endpoints.
- Production startup validation requires HANA, XSUAA, Destination service, an ABAP destination name, and the ABAP data source.

## Not validated

- BTP role-collection creation/assignment and mapping of actual XSUAA JWT scopes into CAP roles.
- App Router process startup on Node.js 22/24, browser login/logout, session cookies, token expiry, CSRF behavior, or unauthorized route handling in Cloud Foundry.
- Identity propagation to the ABAP communication arrangement. The Destination's authentication method and whether principal propagation is required remain tenant/security-owner decisions.
- Cloud Foundry route exposure and health-check behavior with real service bindings.

## Required non-production validation

1. Deploy in an isolated Cloud Foundry space with XSUAA and Destination bindings and Node.js 22 or 24 for the App Router.
2. Create and assign approved role collections to test identities. Verify actual JWT scopes yield only intended CAP roles.
3. Exercise login/logout, token expiry, unauthenticated API/OData requests, reader/requester/approver permissions, self-approval denial, and CSRF-protected state changes.
4. Verify health routes disclose no credit data and protected application routes cannot be reached around the App Router.
5. Confirm the configured Destination identity has only the required ABAP read permissions.

No live authentication flow or SAP request was executed.
