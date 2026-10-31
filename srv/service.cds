using credit from '../db/schema';

service CreditService {
  entity Customers as projection on credit.Customers;
  entity OpenItems as projection on credit.OpenItems;
  entity LimitRequests as projection on credit.LimitRequests;
}
