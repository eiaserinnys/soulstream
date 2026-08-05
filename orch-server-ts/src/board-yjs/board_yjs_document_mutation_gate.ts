type Release = () => void;

/**
 * Serializes every in-process mutation of a Board Y.Doc by document name.
 * Multi-document operations acquire names in lexical order, so direct and
 * staged moves cannot deadlock while sharing the same exclusion boundary.
 */
export class BoardYjsDocumentMutationGate {
  private readonly tails = new Map<string, Promise<void>>();

  async withMutation<T>(
    documentNames: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> {
    return await this.withLocks(documentNames, work);
  }

  private async withLocks<T>(
    documentNames: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> {
    const releases: Release[] = [];
    try {
      for (const name of normalizeNames(documentNames)) {
        releases.push(await this.acquire(name));
      }
      return await work();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async acquire(documentName: string): Promise<Release> {
    const previous = this.tails.get(documentName) ?? Promise.resolve();
    let release!: Release;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held, () => held);
    this.tails.set(documentName, tail);
    await previous.catch(() => undefined);
    return () => {
      release();
      if (this.tails.get(documentName) === tail) this.tails.delete(documentName);
    };
  }
}

function normalizeNames(documentNames: readonly string[]): string[] {
  const names = [...new Set(documentNames)];
  if (names.length === 0 || names.some((name) => !name.trim())) {
    throw new Error("Board Y.Doc mutation gate requires document names");
  }
  return names.sort();
}
