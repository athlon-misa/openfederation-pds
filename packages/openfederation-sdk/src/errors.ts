export class OpenFederationError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'OpenFederationError';
    this.status = status;
    this.code = code;
  }
}

export class AuthenticationError extends OpenFederationError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'Unauthorized');
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends OpenFederationError {
  constructor(message: string) {
    super(message, 400, 'InvalidRequest');
    this.name = 'ValidationError';
  }
}

export class ConflictError extends OpenFederationError {
  constructor(message: string = 'Handle or email is already in use') {
    super(message, 409, 'AccountExists');
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends OpenFederationError {
  constructor(message: string = 'Too many requests, please try again later') {
    super(message, 429, 'RateLimitExceeded');
    this.name = 'RateLimitError';
  }
}

export class ForbiddenError extends OpenFederationError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'Forbidden');
    this.name = 'ForbiddenError';
  }
}

/** Map an HTTP error response to the appropriate error class */
export function errorFromResponse(status: number, body: { error?: string; message?: string }): OpenFederationError {
  const message = body.message || body.error || 'Unknown error';
  const code = body.error || 'UnknownError';

  switch (status) {
    case 400:
      return new ValidationError(message);
    case 401:
      return new AuthenticationError(message);
    case 403:
      return new ForbiddenError(message);
    case 409:
      return new ConflictError(message);
    case 429:
      return new RateLimitError(message);
    default:
      return new OpenFederationError(message, status, code);
  }
}
