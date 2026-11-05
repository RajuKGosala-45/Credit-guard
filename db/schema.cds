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
