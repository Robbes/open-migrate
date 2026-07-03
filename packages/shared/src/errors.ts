/** Thrown by not-yet-implemented stubs so unfinished seams fail loudly and obviously. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}
