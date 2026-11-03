using credit from '../db/schema';

@requires: 'CreditReader'
service CreditService {
  @readonly
  entity Customers as projection on credit.Customers;
  @readonly
  entity OpenItems as projection on credit.OpenItems;
  @readonly
  entity LimitRequests as projection on credit.LimitRequests;
  @readonly
  entity ApprovalHistory as projection on credit.ApprovalHistory;
}
