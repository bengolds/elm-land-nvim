# elm-land-lsp

A Bun-based LSP server for Elm, porting features from [elm-land/vscode](https://github.com/elm-land/vscode) to work with Neovim's built-in LSP client.

## Project Layout

```
elm-land-lsp/
  bin/elm-land-lsp.ts              # Entry point
  src/
    server.ts                      # Stdin reader, JSON-RPC router
    protocol/{transport,messages,capabilities}.ts
    features/{diagnostics,formatting,definition,document-symbol}.ts
    elm-ast/{worker,bridge,types}.ts + worker.min.js
    project/{elm-json,elm-home,module-resolver}.ts
    state/{document-store,ast-cache}.ts
```

## Running

```bash
cd elm-land-lsp
bun run bin/elm-land-lsp.ts   # Reads LSP JSON-RPC on stdin, writes on stdout
```

## Tests

```bash
cd elm-land-lsp
bun test                      # All tests (45 tests, ~3s)
bun test test/transport.test.ts  # Transport encode/decode
bun test test/ast.test.ts        # AST parser + helpers
bun test test/elm-json.test.ts   # elm.json parsing, module resolution
bun test test/lsp.test.ts        # LSP integration (symbols, definition, formatting)
bun test test/perf.test.ts       # Performance against noredink-ui (99 files)
```

Test fixtures:
- `test/fixtures/small-project/` — 5-file Elm app for unit/integration tests
- `test/fixtures/noredink-ui/` — symlink to /tmp/noredink-ui (230 files, 88K LOC) for perf tests. Clone with: `git clone --depth 1 https://github.com/NoRedInk/noredink-ui.git /tmp/noredink-ui`

Performance baseline (M-series Mac): ~540 files/sec parse throughput, ~13ms avg per file including the largest (268KB).


## Testing in Neovim (Isolated — Won't Touch Your Config)

Use `NVIM_APPNAME` to create a completely isolated Neovim instance. This uses separate config/data/state directories under `~/.config/<name>/`, `~/.local/state/<name>/`, etc.

### Setup

```bash
# 1. Create isolated config
mkdir -p ~/.config/elm-lsp-test/lsp

# 2. Write minimal init.lua
cat > ~/.config/elm-lsp-test/init.lua << 'EOF'
vim.filetype.add({ extension = { elm = "elm" } })
vim.lsp.enable("elm_land")
vim.diagnostic.config({ virtual_text = true })
EOF

# 3. Write LSP config (update the path!)
cat > ~/.config/elm-lsp-test/lsp/elm_land.lua << 'EOF'
return {
  cmd = { "bun", "run", "/ABSOLUTE/PATH/TO/elm-land-lsp/bin/elm-land-lsp.ts" },
  filetypes = { "elm" },
  root_markers = { "elm.json" },
}
EOF
```

### Launch

```bash
# In tmux (for agent use):
tmux new-session -d -s elm-test -x 120 -y 40 \
  "NVIM_APPNAME=elm-lsp-test nvim /path/to/some-elm-project/src/Main.elm"

# Interactive:
NVIM_APPNAME=elm-lsp-test nvim /path/to/some-elm-project/src/Main.elm
```

### Verify Features

From inside Neovim:
- **LSP attached?** — `:lua for _,c in ipairs(vim.lsp.get_clients()) do print(c.name) end`
- **Diagnostics** — Save a file with a type error, error appears as virtual text
- **Formatting** — `:lua vim.lsp.buf.format()`
- **Document symbols** — `:lua vim.lsp.buf.document_symbol()`
- **Jump to definition** — Position cursor on a function name, `:lua vim.lsp.buf.definition()`
- **LSP log** — `cat ~/.local/state/elm-lsp-test/lsp.log`

### Cleanup

```bash
rm -rf ~/.config/elm-lsp-test ~/.local/state/elm-lsp-test \
       ~/.local/share/elm-lsp-test ~/.cache/elm-lsp-test
```

## Test Elm Project

A minimal test project exists at `/tmp/elm-test-project/` with `elm.json`, `src/Main.elm`, `src/Helpers.elm`, and `src/App.elm`. If it doesn't exist, create one:

```bash
mkdir -p /tmp/elm-test-project/src
cat > /tmp/elm-test-project/elm.json << 'EOF'
{
    "type": "application",
    "source-directories": ["src"],
    "elm-version": "0.19.1",
    "dependencies": {
        "direct": { "elm/browser": "1.0.2", "elm/core": "1.0.5", "elm/html": "1.0.0" },
        "indirect": { "elm/json": "1.1.3", "elm/time": "1.0.0", "elm/url": "1.0.0", "elm/virtual-dom": "1.0.3" }
    },
    "test-dependencies": { "direct": {}, "indirect": {} }
}
EOF
```

## Architecture Notes

- **Zero npm dependencies** — pure Bun APIs, hand-rolled LSP transport
- **AST parser** — compiled Elm app (`worker.min.js` from stil4m/elm-syntax 7.3.8) runs in a Bun Worker thread. The Elm port sends pre-parsed JS objects (not JSON strings).
- **AST types** — `types.ts` mirrors the actual parser output, which differs from elm-land/vscode's TypeScript types in some places (e.g., `TopLevelExpose.function` is `{ name: string }` not `string`)
- **Diagnostics** — shells out to `elm make --report=json`, debounced 300ms
- **Formatting** — pipes to `elm-format --stdin --yes`
- **Definition** — AST-based: local scope → same-file → cross-module (local project files only, not packages)
- **Document symbols** — AST declaration extraction with let-binding children

## Rebuilding worker.min.js

The compiled Elm parser is built from `/tmp/elm-land-vscode/src/features/shared/elm-to-ast/src/Worker.elm`. To rebuild:

```bash
cd /tmp/elm-land-vscode/src/features/shared/elm-to-ast
elm make src/Worker.elm --optimize --output=worker.js
cp worker.js /path/to/elm-land-lsp/src/elm-ast/worker.min.js
```

Requires `elm` 0.19.1 and the elm-land/vscode repo cloned to `/tmp/elm-land-vscode`.

## Feature Comparison vs elm-land/vscode

Reference clone at `elm-land-vscode/` (gitignored). Source files in `elm-land-vscode/src/features/`.

### Features we match or exceed:

| Feature | elm-land | Us | Notes |
|---------|----------|-----|-------|
| Diagnostics | Yes | Yes | We also notify when elm binary missing |
| Formatting | Yes | Yes | We also notify when elm-format missing |
| Document Symbols | Yes | Yes | Parity |
| Jump to Definition | Yes | **Better** | We handle type annotations, case patterns, local vars, recordUpdate names |
| Workspace Symbols | Yes | **Better** | Our symbol kinds are more specific |
| Autocomplete | Yes | Yes | Qualified `.` completion with real type sigs |
| Hover | No | **Yes** | Full type signatures + docs from AST and package docs.json |
| Find References | No | **Yes** | Cross-file, walks expressions + imports + module exposing + type sigs |
| Rename | No | **Yes** | Full project rename including imports and module exposing |

### Remaining gaps:

| Feature | Difficulty | Notes |
|---------|-----------|-------|
| Document Links | MEDIUM | Link package refs to docs URLs |
| HTML to Elm | HARD | Niche code action |

### Running tests:
```bash
cd elm-land-lsp
bun test test/transport.test.ts test/ast.test.ts test/elm-json.test.ts test/lsp.test.ts test/perf.test.ts test/benchmark.test.ts
```
73 tests, ~21s (most time in elm-package-universe benchmark parsing 7K files).

### Performance (elm-package-universe, 7000 files, 601K LOC):
- Parse throughput: ~830 files/sec
- Document symbols: p50=37ms
- Workspace symbols: p50=7ms (cached)
- Completion: p50=1ms
- Hover: p50=0.7ms
- Definition: p50=0.7ms
