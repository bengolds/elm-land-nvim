-- Neovim 0.11+ LSP configuration for elm-land-lsp
-- Place this at: ~/.config/nvim/lsp/elm_land.lua

return {
  cmd = { "bun", "run", vim.fn.expand("~/src/tries/2026-02-27-elm-land-nvim/elm-land-lsp/bin/elm-land-lsp.ts") },
  filetypes = { "elm" },
  root_markers = { "elm.json" },
}

-- Then add to your init.lua (or after/plugin/lsp.lua):
-- vim.lsp.enable("elm_land")
