# Browser2IDE Source Plugin Fixture

This private VS Code extension proves that an extension outside the Browser2IDE
core can register a `SourcePlugin` through the public API. It contributes the
`browser2ide-fixture` language for `.b2i` files and registers plugin ID
`browser2ide.fixture`.

Its manifest depends on the canonical core extension ID
`browser2ide.browser2ide-vscode`. Activation calls the core extension, compares
its API with `SOURCE_PLUGIN_API_VERSION`, and disposes the result of
`registerSourcePlugin` with the fixture extension context.

Build the fixture from the repository root:

```powershell
corepack pnpm --filter source-plugin-fixture build
```

Run the real cross-extension test with Node.js 22 or newer:

```powershell
corepack pnpm test:integration
```

The fixture is test infrastructure, not a production source resolver. Copy its
manifest and activation pattern when starting another source plugin, then use
the contract and ecosystem guidance in `docs/source-plugin-authoring.md`.
