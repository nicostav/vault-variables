# Vault Variables

Define variables once and use them as `{{name}}` anywhere in your notes.

If you keep setup notes with the same IP, hostname, or username scattered
across many snippets, this plugin lets you change the value in one place and
have every note update.

## Usage

- Open the settings tab, or click the braces icon in the ribbon ("Edit vault
  variables"), to add, edit, reorder, or delete variables.
- Use `{{name}}` anywhere in a note — plain text, lists, tables, headings,
  callouts, inline code, and fenced code blocks. Type `{{` in the editor to
  get an autocomplete popup listing your variables.
- Substitution only happens in **Reading view**. Source mode and Live
  Preview always show the raw `{{name}}`, and note files are never modified.
- Undefined variables are left as the literal `{{name}}` and highlighted, so
  you can spot typos or values you haven't set yet. This can be turned off
  in settings.
- The native code-block copy button copies the substituted text, not the
  raw `{{name}}` source.
- Editing a variable updates any open Reading views immediately.

## Installation

### Community plugins

Search for "Vault Variables" in Obsidian's community plugins browser and
install it from there.

### Manual

Copy `main.js`, `manifest.json`, and `styles.css` from a
[release](https://github.com/nicostav/vault-variables/releases) into
`<vault>/.obsidian/plugins/vault-variables/`, then enable the plugin in
Obsidian's settings.

## Issues

Please file issues on [Disroot](https://git.disroot.org/nicostav/vault-variables/issues).

## Development

```
npm install
npm run dev     # esbuild watch mode
npm run build   # typecheck + production build
npm run lint
```

### Releasing

```
npm version patch   # or minor/major
git push --follow-tags
npm run build
gh release create <version> main.js manifest.json styles.css --title <version>
```

The git tag must equal the `manifest.json` version exactly, with no `v`
prefix.

## License

MIT, see [LICENSE](LICENSE).
