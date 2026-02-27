export const serverCapabilities = {
  textDocumentSync: {
    openClose: true,
    change: 1, // Full content sync
    save: { includeText: false },
  },
  documentFormattingProvider: true,
  documentSymbolProvider: true,
  hoverProvider: true,
  completionProvider: {
    triggerCharacters: ["."],
  },
  definitionProvider: true,
  workspaceSymbolProvider: true,
};
