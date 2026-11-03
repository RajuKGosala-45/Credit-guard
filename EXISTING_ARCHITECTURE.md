# Existing Architecture

## System overview

The project is structured as a CAP-based application that combines a browser frontend, business APIs, and an AI assistant layer.

```text
Browser UI (HTML / CSS / JS)
        |
        v
Express + CAP API layer
        |
        +--> business rules (srv/rules.js)
        +--> credit data model (db/schema.cds)
        +--> tool-assisted assistant (srv/agent.js)
        +--> document extraction (srv/documents.js)
        +--> in-memory SQLite database
```

## Frontend layer

Location: `app/credit/`

The frontend is a static HTML/JS app served by Express. It includes:
- portfolio dashboard
- customer list and detail panel
- approval workflow UI
- assistant chat interface
- document upload region

This is intentionally simple and easy to run without a separate build pipeline.

## API and service layer

Location: `srv/server.js`

The server adds Express routes for:
- dashboard summaries
- customer queries
- limit-requests list and creation
- decision handling
- assistant chat
- document analysis

These routes are the integration boundary between the browser and the business logic.

## Data model

Location: `db/schema.cds`

The CDS model includes:
- `Customers`
- `OpenItems`
- `LimitRequests`

This is the authoritative structure for credit data and request history.

## Business rules

Location: `srv/rules.js`

This file contains the core logic for:
- customer status classification
- utilisation calculations
- overdue-risk detection
- stale-review detection
- approval routing
- role-based decision permission

It is the correct place for deterministic domain logic and should remain the source of truth for calculations.

## AI layer

Location: `srv/agent.js`

The assistant currently provides:
- customer lookup tools
- exposure summaries by grouping
- pending-limit request listing
- proposal creation for a new request
- Anthropic integration when configured
- offline fallback when no key is available

This is a useful implementation layer, but it is not yet a full orchestration engine.

## Document analysis

Location: `srv/documents.js`

The document system supports:
- PDF extraction
- DOCX extraction
- TXT extraction
- text-length enforcement before AI processing

This keeps the system usable while limiting untrusted document verbosity.

## Strengths of the current architecture

- minimal complexity
- domain logic centralized
- functional workflow for approvals
- no whole-project rewrite required
- lower-risk modernization path

## Weak points

- in-memory database is demo-only
- AI layer is not a true agent platform
- no persistent conversation/task history
- no robust provider abstraction
- no explicit job/audit log layer
- no dedicated AI service boundary

## Architectural conclusion

The current repository is already a credible business demo and a good foundation for a more advanced AI credit platform. The most appropriate strategy is to evolve the existing Node/CAP architecture rather than replace it outright.
