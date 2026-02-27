export const serverCapabilities = {
  textDocumentSync: {
    openClose: true,
    change: 1, // Full content sync
    save: { includeText: false },
  },
  documentFormattingProvider: true,
  documentSymbolProvider: true,
  completionProvider: {
    triggerCharacters: ["."],
  },
  definitionProvider: true,
  workspaceSymbolProvider: true,
};
