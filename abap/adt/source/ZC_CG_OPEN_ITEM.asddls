@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Credit Guard open-item API projection'
@Metadata.ignorePropagatedAnnotations: true
define root view entity ZC_CG_OPEN_ITEM
  as projection on ZI_CG_OPEN_ITEM
{
  key OpenItemId,
      CustomerId,
      Type,
      Amount,
      Currency,
      DueDate,
      Status
}
