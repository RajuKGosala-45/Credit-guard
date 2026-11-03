@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Credit Guard customer API projection'
@Metadata.ignorePropagatedAnnotations: true
define root view entity ZC_CG_CUSTOMER
  as projection on ZI_CG_CUSTOMER
{
  key CustomerId,
      CustomerName,
      CreditLimit,
      Currency,
      ReviewDate,
      Country,
      CompanyCode,
      RiskClass
}
