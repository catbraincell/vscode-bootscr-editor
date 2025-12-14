# U-Boot `boot.scr` Custom Editor for VS Code

Edit U-Boot `boot.scr` **in place** inside VS Code using a Custom Editor. The extension extracts the embedded script text from the binary `boot.scr`, lets you edit it in a dedicated editor view, and repacks it back into a valid `boot.scr` on save.

This repo targets a specific `boot.scr` layout that is **always length-prefixed**:

- Legacy uImage header: `0..63` (64 bytes)
- Script wrapper:
  - `u32_be script_len` at offset `64`
  - `u32_be 0x00000000` padding at offset `68`
  - Script bytes at offset `72` for `script_len` bytes

## Features

- **Custom Editor for `*.scr`**: open `boot.scr` directly in the custom editor.
- **Edit and save in place**: `Ctrl/Cmd+S` repacks and writes back to the same `boot.scr`.
- **Strict format validation**:
  - Verifies the payload has the `[len][0x00000000]` prefix.
  - Checks that `script_len` fits inside the image payload.
- **CRC mismatch warnings**:
  - If header CRC or data CRC does not match, the extension shows a VS Code warning toast (it does not block editing).

## Usage

1. Open a folder containing `boot.scr`.
2. Click `boot.scr` in the Explorer.
3. The file opens using the **U-Boot boot.scr Editor** custom editor (default).
4. Edit the script text.
5. Press `Ctrl/Cmd+S` to rebuild and save the binary `boot.scr`.

### Undo / Redo

- `Ctrl/Cmd+Z` performs undo
- `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` performs redo

Undo/redo is integrated with VS Code via the Custom Editor edit stack.

## Requirements

- VS Code version supporting Custom Editors (modern VS Code releases).
- No external tools required (`mkimage`/`dumpimage` not needed).

## Development

Install dependencies, build, and run the extension in an Extension Development Host.

```bash
npm install
npm run compile
