namespace credit;

entity Customers {
  key ID             : String(12);
      name           : String(100);
      country        : String(40);
      companyCode    : String(4);
      currency       : String(3);
      creditLimit    : Decimal(15, 2);
      riskClass      : String(1);
      lastReviewDate : Date;
      openItems      : Composition of many OpenItems on openItems.customer = $self;
      payments       : Composition of many Payments on payments.customer = $self;
      requests       : Composition of many LimitRequests on requests.customer = $self;
}

entity OpenItems {
  key ID          : String(12);
      customer    : Association to Customers;
      type        : String(20);
      amount      : Decimal(15, 2);
      currency    : String(3);
      dueDate     : Date;
      status      : String(10);
}

entity Payments {
  key ID          : String(12);
      customer    : Association to Customers;
      reference   : String(40);
      amount      : Decimal(15, 2);
      currency    : String(3);
      postingDate : Date;
      status      : String(16);
}

entity LimitRequests {
  key ID             : String(12);
      customer       : Association to Customers;
      currentLimit   : Decimal(15, 2);
      requestedLimit : Decimal(15, 2);
      reason         : String(500);
      requestedBy    : String(100);
      status         : String(10);
      approverLevel  : String(30);
      decidedBy      : String(100);
      createdAt      : Timestamp;
      decidedAt      : Timestamp;
}

entity LimitRequestIdempotency {
  key ID          : String(64);
      request_ID  : String(12) not null;
      requester_ID: String(100) not null;
      payloadHash : String(64) not null;
}

entity ApprovalHistory {
  key ID             : UUID;
      request_ID     : String(12) not null;
      requester_ID   : String(100) not null;
      approver_ID    : String(100) not null;
      previousStatus : String(10) not null;
      newStatus      : String(10) not null;
      decisionReason : String(500) not null;
      timestamp      : Timestamp not null;
}

entity AgentConversations {
  key ID        : UUID;
      owner_ID  : String(100) not null;
      createdAt : Timestamp not null;
      updatedAt : Timestamp not null;
}

entity AgentMessages {
  key ID              : UUID;
      conversation_ID  : UUID not null;
      owner_ID         : String(100) not null;
      role             : String(10) not null;
      content          : LargeString not null;
      createdAt        : Timestamp not null;
}

entity AgentExecutions {
  key ID            : UUID;
      user_ID        : String(100) not null;
      conversation_ID: UUID;
      status         : String(20) not null;
      stepCount      : Integer not null;
      startedAt      : Timestamp not null;
      completedAt    : Timestamp;
      errorCategory  : String(40);
      providerFallback: Boolean not null default false;
      providerErrorCategory: String(40);
      planId         : String(64);
      planVersion    : Integer;
      planStatus     : String(24);
      planData       : LargeString;
      taskResults    : LargeString;
      recoveryData   : LargeString;
      recoveryStatus : String(24);
      updatedAt      : Timestamp;
}

entity AgentExecutionSteps {
  key ID           : UUID;
      execution_ID  : UUID not null;
      sequence      : Integer not null;
      toolName      : String(80) not null;
      status        : String(20) not null;
      summary       : String(500);
      startedAt     : Timestamp not null;
      completedAt   : Timestamp;
      taskId        : String(64);
      attempt       : Integer;
      outcome       : String(24);
      errorCategory : String(40);
}

entity DataSources {
  key sourceId              : String(64);
      sourceName            : String(120) not null;
      sourceType            : String(32) not null;
      enabled               : Boolean not null default false;
      supportedEntities     : LargeString not null;
      mappingVersion        : String(32) not null;
      authenticationReference: String(160);
      configurationReference: String(160) not null;
      createdAt             : Timestamp not null;
      updatedAt             : Timestamp not null;
}

@assert.unique.ingestionIdempotency: [idempotencyKey]
entity IngestionRuns {
  key ID                  : UUID;
      idempotencyKey      : String(160) not null;
      sourceId            : String(64) not null;
      status              : String(32) not null;
      decisionEligible    : Boolean not null default false;
      snapshotPromoted    : Boolean not null default false;
      startedAt           : Timestamp not null;
      completedAt         : Timestamp;
      retrievedAt         : Timestamp;
      sourceTimestamp     : Timestamp;
      triggeredBy         : String(100) not null;
      attemptCount        : Integer not null default 0;
      rowCounts           : LargeString;
      errorCategory       : String(40);
}

@assert.unique.canonicalRunIdentity: [sourceId, sourceEntity, sourceRecordId, ingestionRun_ID]
entity CanonicalRecords {
  key ID                  : UUID;
      sourceId            : String(64) not null;
      entityType          : String(32) not null;
      sourceEntity        : String(120) not null;
      sourceRecordId      : String(256) not null;
      sourceValues        : LargeString not null;
      sourceUpdatedAt     : Timestamp;
      retrievedAt         : Timestamp not null;
      ingestedAt          : Timestamp not null;
      ingestionRun_ID     : UUID not null;
      mappingVersion      : String(32) not null;
      canonicalData       : LargeString not null;
      active              : Boolean not null default false;
}

entity IngestionQualityIssues {
  key ID                  : UUID;
      ingestionRun_ID     : UUID not null;
      code                : String(64) not null;
      severity            : String(12) not null;
      entityType          : String(32);
      sourceRecordId      : String(256);
      field               : String(120);
      message             : String(500) not null;
      createdAt           : Timestamp not null;
}

entity IngestionCheckpoints {
  key sourceId            : String(64);
  key entityType          : String(32);
      cursor              : LargeString;
      sourceTimestamp     : Timestamp;
      ingestionRun_ID     : UUID;
      updatedAt           : Timestamp not null;
}

entity IngestionSourceLocks {
  key sourceId            : String(64);
      run_ID              : UUID;
      lockToken           : String(36);
      leaseUntil          : Timestamp not null;
      updatedAt           : Timestamp not null;
}

@assert.unique.runSlot: [slotKey]
entity MonitoringRuns {
  key ID                : UUID;
      slotKey           : String(100) not null;
      runKind           : String(16) not null;
      status            : String(20) not null;
      source            : String(80);
      startedAt         : Timestamp not null;
      completedAt       : Timestamp;
      retrievedAt       : Timestamp;
      sourceTimestamp   : Timestamp;
      freshness         : String(16);
      rulesVersion      : String(20) not null;
      summary           : LargeString;
      advisorySummary   : LargeString;
      advisorySource    : String(24);
      advisoryErrorCategory: String(40);
      errorCategory     : String(40);
      attemptCount      : Integer not null default 0;
      recoveryStatus    : String(24) not null;
      leaseUntil        : Timestamp;
      triggeredBy       : String(100) not null;
      workerToken       : String(36);
}

entity MonitoringWorkerLocks {
  key ID          : String(32);
      run_ID      : UUID;
      claimToken  : String(36);
      leaseUntil  : Timestamp not null;
      updatedAt   : Timestamp not null;
}

@assert.unique.runCustomer: [run_ID, customer_ID]
entity MonitoringFindings {
  key ID             : UUID;
      run_ID         : UUID not null;
      customer_ID    : String(12) not null;
      customerName   : String(100) not null;
      status         : String(20) not null;
      severity       : String(16) not null;
      conditions     : LargeString not null;
      exposure       : Decimal(15, 2) not null;
      creditLimit    : Decimal(15, 2) not null;
      utilisation    : Decimal(15, 6);
      overdueAmount  : Decimal(15, 2) not null;
      overdueShare   : Decimal(9, 6) not null;
      currency       : String(3);
      source         : String(80) not null;
      retrievedAt    : Timestamp not null;
}

@assert.unique.customerCondition: [customer_ID, conditionKey]
entity MonitoringAlerts {
  key ID              : UUID;
      customer_ID     : String(12) not null;
      customerName    : String(100) not null;
      conditionKey    : String(40) not null;
      severity        : String(16) not null;
      status          : String(16) not null;
      firstSeenAt     : Timestamp not null;
      lastSeenAt      : Timestamp not null;
      acknowledgedAt  : Timestamp;
      acknowledgedBy  : String(100);
      resolvedAt      : Timestamp;
      resolvedBy      : String(100);
      lastRun_ID      : UUID not null;
      currency        : String(3);
      exposure        : Decimal(15, 2) not null;
      creditLimit     : Decimal(15, 2) not null;
      utilisation     : Decimal(15, 6);
      overdueAmount   : Decimal(15, 2) not null;
}

entity MonitoringAlertEvents {
  key ID          : UUID;
      alert_ID    : UUID not null;
      run_ID      : UUID;
      eventType   : String(24) not null;
      actor_ID    : String(100) not null;
      createdAt   : Timestamp not null;
      details     : String(240);
}

@assert.unique.idempotencyKey: [idempotencyKey]
entity MonitoringNotificationOutbox {
  key ID              : UUID;
      idempotencyKey  : String(160) not null;
      alert_ID        : UUID not null;
      channel         : String(16) not null;
      status          : String(16) not null;
      attemptCount    : Integer not null default 0;
      nextAttemptAt   : Timestamp;
      deliveredAt     : Timestamp;
      errorCategory   : String(40);
      createdAt       : Timestamp not null;
      updatedAt       : Timestamp not null;
}

// ============================================================================
// PHASE 1: SAP S/4HANA FIN-FSCM-CR 3-LAYER CANONICAL SCHEMA (RAW -> CANONICAL -> CALCULATION)
// Note: All SAP table/API references carry verified = false ("verify in SE11/SE16N or SAP Business Accelerator Hub")
// ============================================================================

entity CG_DATA_SOURCE {
  key source_id             : String(64);
      source_name           : String(120) not null;
      source_type           : String(32) not null; // FILE | SAP_ODATA | SAP_BTP_DEST | HANA | REST_API | MOCK_SAP
      connection_config_ref : String(160) not null; // Env var or BTP Destination name (never raw secrets)
      status                : String(24) not null default 'ACTIVE';
      last_sync_at          : Timestamp;
      created_at            : Timestamp not null;
}

entity CG_FIELD_MAPPING {
  key mapping_id             : String(64);
      source_id              : String(64) not null;
      source_entity          : String(120) not null;
      source_field           : String(120) not null;
      canonical_entity       : String(64) not null;
      canonical_field        : String(64) not null;
      transform_rule         : String(64) default 'NONE'; // DATE_YYYYMMDD | DECIMAL | CURRENCY_ISO | TRIM | PAD_LEFT_10 | NONE
      confidence             : Decimal(5, 4) not null default 1.0000;
      verified_by_user       : Boolean not null default false;
      sap_reference_table    : String(64);
      sap_reference_field    : String(64);
      sap_reference_verified : Boolean not null default false;
      verification_note      : String(256) not null default 'verify in SE11/SE16N or SAP Business Accelerator Hub';
      updated_at             : Timestamp;
}

entity CG_RAW_PAYLOAD {
  key payload_id    : String(64);
      source_id     : String(64) not null;
      entity_type   : String(64) not null;
      raw_json      : LargeString not null;
      ingested_at   : Timestamp not null;
      row_hash      : String(64) not null;
      sync_batch_id : String(64) not null;
}

// SAP reference: BUT000 / KNA1 / KNB1 (verified: false — verify in SE11/SE16N or SAP Business Accelerator Hub)
entity CG_BUSINESS_PARTNER {
  key bp_id              : String(32);
      source_id          : String(64) not null;
      external_bp_number : String(32) not null;
      bp_name            : String(120) not null;
      country_code       : String(40) not null;
      company_code       : String(12) not null;
      risk_class         : String(16);
      credit_segment     : String(16) not null default 'MAIN';
      currency           : String(3) not null;
      status             : String(16) not null default 'ACTIVE';
      updated_at         : Timestamp not null;
}

// SAP reference: UKMBP_CMS_SGM / UKMBP_CMS (verified: false — verify in SE11/SE16N or SAP Business Accelerator Hub)
entity CG_BP_CREDIT_SEGMENT {
  key bp_id            : String(32);
  key credit_segment   : String(16);
      credit_limit     : Decimal(18, 2) not null;
      currency         : String(3) not null;
      limit_valid_to   : Date;
      credit_blocked   : Boolean not null default false;
      block_reason     : String(120);
      risk_class       : String(16);
      last_review_date : Date;
      source_id        : String(64) not null;
      updated_at       : Timestamp not null;
}

// SAP reference: UKM_ITEM / open orders + deliveries + billing + FI-AR (verified: false — verify in SE11/SE16N or SAP Business Accelerator Hub)
entity CG_CREDIT_EXPOSURE_ITEM {
  key item_id                    : String(64);
      bp_id                      : String(32) not null;
      credit_segment             : String(16) not null default 'MAIN';
      company_code               : String(12) not null;
      exposure_category          : String(24) not null; // OPEN_ORDER | OPEN_DELIVERY | OPEN_BILLING | OPEN_INVOICE
      source_doc_number          : String(40) not null;
      source_doc_type            : String(24) not null;
      amount                     : Decimal(18, 2) not null;
      currency                   : String(3) not null;
      amount_in_segment_currency : Decimal(18, 2) not null;
      posting_date               : Date;
      due_date                   : Date;
      is_overdue                 : Boolean not null default false;
      days_overdue               : Integer not null default 0;
      source_id                  : String(64) not null;
      updated_at                 : Timestamp not null;
}

// SAP reference: ACDOCA / BSID (verified: false — verify in SE11/SE16N or SAP Business Accelerator Hub)
entity CG_OPEN_RECEIVABLE {
  key receivable_id     : String(64);
      bp_id             : String(32) not null;
      company_code      : String(12) not null;
      accounting_doc_no : String(40) not null;
      fiscal_year       : String(4) not null;
      line_item         : String(8) not null;
      invoice_ref       : String(40);
      document_date     : Date;
      baseline_date     : Date;
      due_date          : Date;
      amount_doc_curr   : Decimal(18, 2) not null;
      doc_currency      : String(3) not null;
      amount_local_curr : Decimal(18, 2) not null;
      local_currency    : String(3) not null;
      dunning_level     : Integer not null default 0;
      dispute_flag      : Boolean not null default false;
      clearing_status   : String(16) not null default 'OPEN'; // OPEN | CLEARED | PARTIAL
      source_id         : String(64) not null;
      updated_at        : Timestamp not null;
}

// SAP reference: ACDOCA / BSAD (verified: false — verify in SE11/SE16N or SAP Business Accelerator Hub)
entity CG_PAYMENT_HISTORY {
  key payment_id     : String(64);
      bp_id          : String(32) not null;
      company_code   : String(12) not null;
      payment_doc_no : String(40) not null;
      invoice_ref    : String(40);
      payment_date   : Date not null;
      due_date       : Date;
      days_late      : Integer not null default 0;
      amount         : Decimal(18, 2) not null;
      currency       : String(3) not null;
      source_id      : String(64) not null;
      updated_at     : Timestamp not null;
}

// CALCULATION LAYER — Deterministic credit exposure & ageing snapshot
entity CG_EXPOSURE_SNAPSHOT {
  key snapshot_id            : String(64);
      bp_id                  : String(32) not null;
      credit_segment         : String(16) not null;
      company_code           : String(12) not null;
      country_code           : String(40) not null;
      credit_limit           : Decimal(18, 2) not null;
      open_orders_amount     : Decimal(18, 2) not null default 0;
      open_deliveries_amount : Decimal(18, 2) not null default 0;
      open_billing_amount    : Decimal(18, 2) not null default 0;
      open_ar_amount         : Decimal(18, 2) not null default 0;
      total_exposure         : Decimal(18, 2) not null;
      available_credit       : Decimal(18, 2) not null;
      utilization_pct        : Decimal(9, 2) not null;
      overdue_amount         : Decimal(18, 2) not null default 0;
      overdue_count          : Integer not null default 0;
      ageing_0_30            : Decimal(18, 2) not null default 0;
      ageing_31_60           : Decimal(18, 2) not null default 0;
      ageing_61_90           : Decimal(18, 2) not null default 0;
      ageing_90_plus         : Decimal(18, 2) not null default 0;
      threshold_status       : String(16) not null; // NORMAL | WARNING | CRITICAL | BREACH | BLOCKED
      calculated_at          : Timestamp not null;
      source_id              : String(64) not null;
}

// WORKFLOW LAYER — Credit limit change requests & SAP sync state
entity CG_CREDIT_LIMIT_REQUEST {
  key request_id      : String(32);
      bp_id           : String(32) not null;
      credit_segment  : String(16) not null default 'MAIN';
      company_code    : String(12) not null;
      current_limit   : Decimal(18, 2) not null;
      requested_limit : Decimal(18, 2) not null;
      currency        : String(3) not null;
      justification   : String(1000) not null;
      ai_risk_summary : LargeString;
      status          : String(24) not null default 'PENDING_APPROVAL'; // DRAFT | PENDING_APPROVAL | APPROVED | REJECTED | SYNCED_TO_SAP
      requested_by    : String(100) not null;
      approved_by     : String(100);
      sap_sync_status : String(32) not null default 'NOT_SYNCED';
      created_at      : Timestamp not null;
      decided_at      : Timestamp;
}

