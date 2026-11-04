function cloneTables(tables) {
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [
    name,
    structuredClone(rows)
  ]));
}

function matches(record, where = []) {
  for (let index = 0; index < where.length; index += 1) {
    const field = where[index]?.ref?.[0];
    if (!field) continue;
    if (record[field] !== where[index + 2]?.val) return false;
    index += 2;
  }
  return true;
}

function tableName(source) {
  return source?.ref?.[0];
}

function queryRunner(tables, uniqueFields, { cloneInserts = false } = {}) {
  return async query => {
    if (query.SELECT) {
      const name = tableName(query.SELECT.from);
      let rows = (tables[name] || []).filter(record =>
        matches(record, query.SELECT.where || [])).map(record => ({ ...record }));
      if (query.SELECT.orderBy?.length) {
        rows.sort((left, right) => {
          for (const order of query.SELECT.orderBy) {
            const field = order.ref[0];
            const direction = order.sort === 'desc' ? -1 : 1;
            const comparison = String(left[field]).localeCompare(String(right[field]));
            if (comparison) return comparison * direction;
          }
          return 0;
        });
      }
      if (query.SELECT.limit?.rows?.val !== undefined) {
        rows = rows.slice(0, query.SELECT.limit.rows.val);
      }
      return query.SELECT.one ? rows[0] || null : rows;
    }

    if (query.INSERT) {
      const name = tableName(query.INSERT.into);
      const rows = Array.isArray(query.INSERT.entries)
        ? query.INSERT.entries : [query.INSERT.entries];
      for (const field of uniqueFields[name] || []) {
        if (rows.some(entry => tables[name].some(existing =>
          entry[field] !== null && entry[field] !== undefined
          && existing[field] === entry[field]))) {
          throw new Error(`Unique constraint violation for ${name}.${field}.`);
        }
      }
      tables[name].push(...(cloneInserts ? structuredClone(rows) : rows));
      return rows.length;
    }

    if (query.UPDATE) {
      const name = tableName(query.UPDATE.entity);
      const rows = (tables[name] || []).filter(record =>
        matches(record, query.UPDATE.where || []));
      for (const row of rows) Object.assign(row, structuredClone(query.UPDATE.data));
      return rows.length;
    }

    if (query.DELETE) {
      const name = tableName(query.DELETE.from);
      const rows = tables[name] || [];
      const retained = rows.filter(record => !matches(record, query.DELETE.where || []));
      tables[name] = retained;
      return rows.length - retained.length;
    }

    throw new Error('Unexpected monitoring database query.');
  };
}

function commitTables(target, committed) {
  for (const [name, rows] of Object.entries(committed)) {
    const existing = target[name] || [];
    const byId = new Map(existing.map(record => [record.ID, record]));
    const merged = rows.map(record => {
      const current = byId.get(record.ID);
      return current ? Object.assign(current, structuredClone(record)) : structuredClone(record);
    });
    existing.splice(0, existing.length, ...merged);
    target[name] = existing;
  }
}

function createMonitoringDatabase({
  tables,
  uniqueFields = {
    'credit.MonitoringRuns': ['ID', 'slotKey'],
    'credit.MonitoringWorkerLocks': ['ID'],
    'credit.MonitoringFindings': ['ID'],
    'credit.MonitoringAlerts': ['ID'],
    'credit.MonitoringAlertEvents': ['ID'],
    'credit.MonitoringNotificationOutbox': ['ID', 'idempotencyKey']
  }
}) {
  let transactionTail = Promise.resolve();
  const database = {
    tables,
    run: queryRunner(tables, uniqueFields),
    async tx(callback) {
      const previousTransaction = transactionTail;
      let releaseTransaction;
      transactionTail = new Promise(resolve => {
        releaseTransaction = resolve;
      });
      await previousTransaction;
      const isolatedTables = cloneTables(tables);
      const transaction = {
        tables: isolatedTables,
        run: queryRunner(isolatedTables, uniqueFields, { cloneInserts: true })
      };
      try {
        const result = await callback(transaction);
        commitTables(tables, isolatedTables);
        return result;
      } finally {
        releaseTransaction();
      }
    }
  };
  return database;
}

module.exports = { createMonitoringDatabase, matches };
