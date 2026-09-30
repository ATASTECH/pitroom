/** An expected, user-facing failure: printed without a stack trace, exits with `code`. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message);
  }
}

/** A patch that would delete files of the user's tree; applied only with their explicit yes (`--allow-delete`). */
export class DeletionRefused extends UserError {
  constructor(
    message: string,
    readonly files: string[],
  ) {
    super(message, 3);
  }
}
