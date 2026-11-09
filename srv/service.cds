using credit from '../db/schema';

@requires: 'CreditReader'
service CreditService {
  @readonly
  entity Customers as projection on credit.Customers;
  @readonly
  entity OpenItems as projection on credit.OpenItems;
  @readonly
  entity Payments as projection on credit.Payments;
  @readonly
  entity LimitRequests as projection on credit.LimitRequests;
  @readonly
  entity ApprovalHistory as projection on credit.ApprovalHistory;

  @readonly
  entity CG_DATA_SOURCE as projection on credit.CG_DATA_SOURCE;
  @readonly
  entity CG_FIELD_MAPPING as projection on credit.CG_FIELD_MAPPING;
  @readonly
  entity CG_RAW_PAYLOAD as projection on credit.CG_RAW_PAYLOAD;
  @readonly
  entity CG_BUSINESS_PARTNER as projection on credit.CG_BUSINESS_PARTNER;
  @readonly
  entity CG_BP_CREDIT_SEGMENT as projection on credit.CG_BP_CREDIT_SEGMENT;
  @readonly
  entity CG_CREDIT_EXPOSURE_ITEM as projection on credit.CG_CREDIT_EXPOSURE_ITEM;
  @readonly
  entity CG_OPEN_RECEIVABLE as projection on credit.CG_OPEN_RECEIVABLE;
  @readonly
  entity CG_PAYMENT_HISTORY as projection on credit.CG_PAYMENT_HISTORY;
  @readonly
  entity CG_EXPOSURE_SNAPSHOT as projection on credit.CG_EXPOSURE_SNAPSHOT;
  @readonly
  entity CG_CREDIT_LIMIT_REQUEST as projection on credit.CG_CREDIT_LIMIT_REQUEST;
}
