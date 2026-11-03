@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Credit Guard customer read model (custom demo contract)'
@Metadata.ignorePropagatedAnnotations: true
define root view entity ZI_CG_CUSTOMER
  as select from zcg_customer
{
  key customer_id as CustomerId,
      customer_name as CustomerName,
      @Semantics.amount.currencyCode: 'Currency'
      credit_limit as CreditLimit,
      @Semantics.currencyCode: true
      currency as Currency,
      review_date as ReviewDate,
      country as Country,
      company_code as CompanyCode,
      risk_class as RiskClass
}
