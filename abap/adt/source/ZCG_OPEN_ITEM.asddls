@EndUserText.label : 'Credit Guard synthetic open-item data'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.deliveryClass : #A
define table zcg_open_item {
  key client       : abap.clnt not null;
  key open_item_id : abap.char(12) not null;
      customer_id  : abap.char(12) not null;
      item_type    : abap.char(20) not null;
      amount       : abap.curr(15,2) not null;
      currency     : abap.cuky not null;
      due_date     : abap.dats;
      status       : abap.char(10) not null;
}
