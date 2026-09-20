// 领域错误：携带稳定错误码与 HTTP 状态，便于离线同步批量结果与接口层共用。
export class DomainError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends DomainError {
  constructor(message, code = 'invalid_event') {
    super(message, code, 400);
  }
}

export class DuplicateLabelError extends DomainError {
  constructor(message) {
    super(message, 'label_duplicate', 409);
  }
}

export class ConflictError extends DomainError {
  constructor(message, code = 'conflict') {
    super(message, code, 409);
  }
}

export class NotFoundError extends DomainError {
  constructor(message) {
    super(message, 'not_found', 404);
  }
}

export class AccessError extends DomainError {
  constructor(message, code = 'access_denied', status = 403) {
    super(message, code, status);
  }
}
