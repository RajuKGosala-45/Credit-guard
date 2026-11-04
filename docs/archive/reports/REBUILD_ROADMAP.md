# Rebuild Roadmap

## Phase 0 — Completed

### Focus
- repository audit
- architecture review
- validation of existing business functionality
- cleanup review without destructive actions
- documentation of preserved assets

### Outcome
The project is confirmed to be a functional CAP/Node credit-monitoring application with a valid business foundation.

## Phase 1 — Stabilize the core foundation

### Objectives
- document the current business rules and API contracts
- validate the existing approval workflow
- identify missing telemetry and error handling
- review in-memory persistence assumptions
- define the minimum safe contract for future agent integration

### Deliverables
- business service inventory
- API contract summary
- security and approval checklist
- baseline test / validation plan

## Phase 2 — Architecture modularization

### Objectives
- separate business logic from orchestration logic
- introduce a provider-independent LLM abstraction
- define tool contracts and schemas
- establish permission checks and approval validation
- add execution logging and audit trail

### Deliverables
- agent controller module
- provider interface and adapters
- tool registry with validated input/output schemas
- execution log service

## Phase 3 — Agent platform maturity

### Objectives
- add multi-step task execution and planning
- integrate memory and retrieval policy
- support document and policy search
- define degraded-mode behavior when LLM is unavailable
- add structured tool validation and retries

### Deliverables
- task-oriented orchestration layer
- retrieval and embedding strategy review
- human-in-the-loop guardrails
- resilient offline fallback behavior

## Phase 4 — Production readiness review

### Objectives
- review persistence strategy
- assess SAP integration boundaries
- confirm security controls and approval enforcement
- add operational monitoring and runbooks

### Deliverables
- migration plan
- deployment checklist
- operational status dashboard
- rollback and audit readiness plan

## Critical guardrail

No destructive file deletions or architecture replacement will happen until the proposed roadmap is approved.

This project should evolve from its current functioning demo into a controlled AI-agent platform in stages.
