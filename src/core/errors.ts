/** An expected, user-facing failure: printed without a stack trace, exits with `code`. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}
