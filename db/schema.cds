namespace credit;

entity Customers {
  key ID             : String(12);
      name           : String(100);
      country        : String(40);
      companyCode    : String(4);
      creditLimit    : Decimal(15, 2);
      riskClass      : String(1);
      lastReviewDate : Date;
      openItems      : Composition of many OpenItems on openItems.customer = $self;
      requests       : Composition of many LimitRequests on requests.customer = $self;
}

entity OpenItems {
  key ID          : String(12);
      customer    : Association to Customers;
      type        : String(20);
      amount      : Decimal(15, 2);
      dueDate     : Date;
      status      : String(10);
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
}
