const { randomBytes } = require('crypto');

const MAX_REASON_LENGTH = 500;
const MAX_REQUESTER_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

function validateLimitRequest(input) {
  const customerId = typeof input?.customerId === 'string' ? input.customerId.trim() : '';
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  const rawLimit = input?.requestedLimit;
  const requestedLimit = typeof rawLimit === 'number'
    ? rawLimit
    : typeof rawLimit === 'string' && rawLimit.trim()
      ? Number(rawLimit)
      : NaN;

  if (!customerId) throw new TypeError('Provide a customer.');
  if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
    throw new TypeError('Provide a positive requested limit.');
  }
  if (!reason) throw new TypeError('Provide a reason.');
  if (reason.length > MAX_REASON_LENGTH) {
    throw new TypeError(`The reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
  }

  return { customerId, requestedLimit, reason };
}

function createLimitRequestId() {
  return randomBytes(9).toString('base64url');
}

function validateActorId(actorId) {
  if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > MAX_REQUESTER_LENGTH) {
    throw new TypeError(`Authenticated user IDs must be 1-${MAX_REQUESTER_LENGTH} characters.`);
  }
  return actorId;
}

function validateIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    const error = new TypeError(`The idempotency key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} valid characters.`);
    error.statusCode = 400;
    throw error;
  }
  return key;
}

module.exports = {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_REASON_LENGTH,
  MAX_REQUESTER_LENGTH,
  createLimitRequestId,
  validateActorId,
  validateIdempotencyKey,
  validateLimitRequest
};
