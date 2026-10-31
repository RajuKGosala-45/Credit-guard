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
