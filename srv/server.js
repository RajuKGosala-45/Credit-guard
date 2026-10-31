require('dotenv').config();
const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { SELECT, INSERT, UPDATE } = cds.ql;
const multer = require('multer');
const { classifyCustomer, routeApprover, canDecide } = require('./rules');
const { chat } = require('./agent');
const { extractDocument, MAX_EXTRACTED_CHARACTERS } = require('./documents');

const number = value => Number(value || 0);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2 }
});

function parseDocumentUpload(req, res, next) {
  documentUpload.single('document')(req, res, error => {
    if (!error) return next();
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'The document exceeds the 10 MB upload limit.' : `Upload failed: ${error.message}`
    });
  });
}

async function customerSummaries() {
  const [customers, items] = await Promise.all([
    cds.db.run(SELECT.from('credit.Customers')),
    cds.db.run(SELECT.from('credit.OpenItems'))
  ]);
  return customers.map(customer =>
    classifyCustomer(customer, items.filter(item => item.customer_ID === customer.ID)));
}

function aggregate(records, key) {
  const grouped = new Map();
  for (const customer of records) {
    const label = customer[key];
    const row = grouped.get(label) || { label, exposure: 0, creditLimit: 0, customers: 0 };
    row.exposure += customer.exposure;
    row.creditLimit += customer.creditLimit;
    row.customers += 1;
    grouped.set(label, row);
  }
  return [...grouped.values()].map(row => ({
    ...row,
    utilisation: row.creditLimit ? row.exposure / row.creditLimit : row.exposure ? Infinity : 0
  })).sort((a, b) => b.exposure - a.exposure);
}

cds.on('bootstrap', app => {
  app.use('/credit', express.static(path.join(__dirname, '..', 'app', 'credit')));
  app.use('/api', express.json());

  app.get('/api/dashboard', async (_req, res) => {
    try {
      const customers = await customerSummaries();
      const totalExposure = customers.reduce((sum, item) => sum + item.exposure, 0);
      const totalLimit = customers.reduce((sum, item) => sum + item.creditLimit, 0);
      res.json({
        kpis: {
          totalExposure, totalLimit, overallUtilisation: totalLimit ? totalExposure / totalLimit : 0,
          customersBreached: customers.filter(item => item.utilisation > 1).length,
          warningCustomers: customers.filter(item => item.status === 'WARNING').length,
          overdueRiskCustomers: customers.filter(item => item.flags.includes('OVERDUE_RISK')).length,
          healthyCustomers: customers.filter(item => item.status === 'HEALTHY').length,
          customerCount: customers.length
        },
        exposure: {
          country: aggregate(customers, 'country'),
          companyCode: aggregate(customers, 'companyCode'),
          customer: aggregate(customers, 'name')
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/customers', async (_req, res) => {
    try { res.json(await customerSummaries()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/customers/:id', async (req, res) => {
    try {
      const customer = (await customerSummaries()).find(item => item.ID === req.params.id);
      if (!customer) return res.status(404).json({ error: `Customer ${req.params.id} was not found.` });
      const openItems = await cds.db.run(SELECT.from('credit.OpenItems').where({ customer_ID: customer.ID }));
      return res.json({ ...customer, openItems });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/limit-requests', async (req, res) => {
    try {
      const query = SELECT.from('credit.LimitRequests').orderBy('createdAt desc');
      if (req.query.status) query.where({ status: req.query.status });
      const requests = await cds.db.run(query);
      const customers = await cds.db.run(SELECT.from('credit.Customers'));
      res.json(requests.map(request => ({
        ...request,
        customerName: customers.find(customer => customer.ID === request.customer_ID)?.name || request.customer_ID
      })));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/limit-requests', async (req, res) => {
    try {
      const { customerId, requestedLimit, reason, requestedBy = 'Demo user' } = req.body || {};
      if (!customerId || !Number.isFinite(Number(requestedLimit)) || Number(requestedLimit) <= 0 || !String(reason || '').trim()) {
        return res.status(400).json({ error: 'Provide a customer, a positive requested limit, and a reason.' });
      }
      const customer = (await cds.db.run(SELECT.from('credit.Customers').where({ ID: customerId })))[0];
      if (!customer) return res.status(404).json({ error: `Customer ${customerId} was not found.` });
      const currentLimit = number(customer.creditLimit);
      const approverLevel = routeApprover(currentLimit, Number(requestedLimit));
      const request = {
        ID: randomUUID(), customer_ID: customerId, currentLimit,
        requestedLimit: Number(requestedLimit), reason: String(reason).trim(),
        requestedBy: String(requestedBy).trim().slice(0, 100) || 'Demo user',
        status: 'Pending', approverLevel, createdAt: new Date().toISOString()
      };
      await cds.db.run(INSERT.into('credit.LimitRequests').entries(request));
      return res.status(201).json(request);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/limit-requests/:id/decision', async (req, res) => {
    try {
      const { decision, role, decidedBy = 'Demo approver' } = req.body || {};
      if (!['Approved', 'Rejected'].includes(decision) || !['Credit Controller', 'Finance Head'].includes(role)) {
        return res.status(400).json({ error: 'Provide an Approved or Rejected decision and a valid approver role.' });
      }
      const request = (await cds.db.run(SELECT.from('credit.LimitRequests').where({ ID: req.params.id })))[0];
      if (!request) return res.status(404).json({ error: 'Limit request was not found.' });
      if (request.status !== 'Pending') return res.status(409).json({ error: 'This request has already been decided.' });
      if (!canDecide(role, request.approverLevel)) {
        return res.status(403).json({ error: `This request is routed to ${request.approverLevel}; the selected role cannot decide it.` });
      }
      const decidedAt = new Date().toISOString();
      await cds.db.tx(async tx => {
        if (decision === 'Approved') {
          await tx.run(UPDATE('credit.Customers')
            .set({ creditLimit: request.requestedLimit }).where({ ID: request.customer_ID }));
        }
        await tx.run(UPDATE('credit.LimitRequests')
          .set({ status: decision, decidedBy: `${String(decidedBy).trim().slice(0, 80) || 'Demo approver'} (${role})`, decidedAt })
          .where({ ID: request.ID, status: 'Pending' }));
      });
      return res.json({ ...request, status: decision, decidedBy: `${decidedBy} (${role})`, decidedAt });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ error: 'Enter a message to chat with the credit-control assistant.' });
      const providedContext = req.body?.documentContext;
      if (providedContext && (
        typeof providedContext.text !== 'string'
        || providedContext.text.length > MAX_EXTRACTED_CHARACTERS
        || typeof providedContext.filename !== 'string'
      )) {
        return res.status(400).json({ error: 'Document context is invalid or exceeds the 20,000-character analysis limit. Upload the document again.' });
      }
      const documentContext = providedContext ? {
        text: providedContext.text,
        filename: path.basename(providedContext.filename).slice(0, 160),
        extractedCharacters: Number(providedContext.extractedCharacters) || providedContext.text.length,
        truncated: providedContext.truncated === true
      } : undefined;
      return res.json(await chat(message, cds.db, documentContext));
    } catch (error) {
      return res.status(502).json({ error: error.message });
    }
  });

  app.post('/api/documents/analyze', parseDocumentUpload, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose a PDF, DOCX, or TXT document to upload.' });
      let extracted;
      try {
        extracted = await extractDocument(req.file);
      } catch (error) {
        return res.status(422).json({ error: error.message });
      }
      const filename = path.basename(req.file.originalname).replace(/[\u0000-\u001f]/g, '').slice(0, 160);
      const documentContext = {
        filename,
        text: extracted.text,
        extractedCharacters: extracted.extractedCharacters,
        truncated: extracted.truncated
      };
      const result = await chat('Read this document and summarize its credit-related facts, customer references, risks, and useful next steps.', cds.db, documentContext);
      return res.json({ ...documentContext, reply: result.reply, offline: result.offline });
    } catch (error) {
      return res.status(502).json({ error: error.message });
    }
  });
});
