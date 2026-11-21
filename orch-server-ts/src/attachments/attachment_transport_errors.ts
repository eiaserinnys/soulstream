export class AttachmentTransportConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentTransportConnectionError";
  }
}

export class AttachmentTransportTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentTransportTimeoutError";
  }
}
