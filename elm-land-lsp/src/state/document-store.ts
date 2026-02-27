export type Document = {
  uri: string;
  text: string;
  version: number;
};

class DocumentStore {
  private docs = new Map<string, Document>();

  open(uri: string, text: string, version: number): void {
    this.docs.set(uri, { uri, text, version });
  }

  change(uri: string, text: string, version: number): void {
    this.docs.set(uri, { uri, text, version });
  }

  close(uri: string): void {
    this.docs.delete(uri);
  }

  get(uri: string): Document | undefined {
    return this.docs.get(uri);
  }

  all(): Document[] {
    return Array.from(this.docs.values());
  }
}

export const documentStore = new DocumentStore();
