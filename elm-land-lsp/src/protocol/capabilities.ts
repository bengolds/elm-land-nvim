export const serverCapabilities = {
  textDocumentSync: {
    openClose: true,
    change: 1, // Full content sync
    save: { includeText: false },
  },
  documentFormattingProvider: true,
  documentSymbolProvider: true,
  definitionProvider: true,
};
