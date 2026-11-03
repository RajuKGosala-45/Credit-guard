@EndUserText.label : 'Credit Guard synthetic customer data'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.deliveryClass : #A
define table zcg_customer {
  key client        : abap.clnt not null;
  key customer_id   : abap.char(12) not null;
      customer_name : abap.char(100) not null;
      credit_limit  : abap.curr(15,2) not null;
      currency      : abap.cuky not null;
      review_date   : abap.dats;
      country       : abap.char(40);
      company_code  : abap.char(4);
      risk_class    : abap.char(1);
}
