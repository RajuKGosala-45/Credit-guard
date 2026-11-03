@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Credit Guard open-item read model (custom demo contract)'
@Metadata.ignorePropagatedAnnotations: true
define root view entity ZI_CG_OPEN_ITEM
  as select from zcg_open_item
{
  key open_item_id as OpenItemId,
      customer_id as CustomerId,
      item_type as Type,
      @Semantics.amount.currencyCode: 'Currency'
      amount as Amount,
      @Semantics.currencyCode: true
      currency as Currency,
      due_date as DueDate,
      status as Status
}
