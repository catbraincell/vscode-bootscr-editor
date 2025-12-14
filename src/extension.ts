import * as vscode from "vscode";
import { buildLegacyScriptImage, parseLegacyUImage, UImageHeader } from "./uimage";

const VIEW_TYPE = "uboot.bootscrEditor";

type BootScrState = {
  text: string;
  header?: UImageHeader;
};

class BootScrDocument extends vscode.Disposable implements vscode.CustomDocument {
  static async create(uri: vscode.Uri): Promise<BootScrDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const parsed = parseLegacyUImage(new Uint8Array(bytes)); // strict length-prefixed

    const state: BootScrState = {
      text: parsed.script,
      header: parsed.header
    };

    return new BootScrDocument(uri, state);
  }

  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  // Optional, but harmless to keep (not used by CustomEditorProvider contract)
  private readonly _onDidChangeDocument = new vscode.EventEmitter<{ readonly content?: Uint8Array }>();
  public readonly onDidChangeDocument = this._onDidChangeDocument.event;

  private _isDirty = false;

  constructor(public readonly uri: vscode.Uri, public state: BootScrState) {
    super(() => this.dispose());
  }

  get isDirty(): boolean {
    return this._isDirty;
  }

  markDirty(dirty: boolean): void {
    this._isDirty = dirty;
    this._onDidChangeDocument.fire({});
  }

  dispose(): void {
    this._onDidDispose.fire();
    super.dispose();
  }
}

class BootScrEditorProvider implements vscode.CustomEditorProvider<BootScrDocument> {
  private readonly _onDidChangeCustomDocument =
    new vscode.EventEmitter<
      vscode.CustomDocumentEditEvent<BootScrDocument> | vscode.CustomDocumentContentChangeEvent<BootScrDocument>
    >();

  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new BootScrEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<BootScrDocument> {
    return BootScrDocument.create(uri);
  }

  async resolveCustomEditor(
    document: BootScrDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const postState = (opts?: { dirty?: boolean }) => {
      webviewPanel.webview.postMessage({
        type: "init",
        text: document.state.text,
        meta: {
          name: document.state.header?.name ?? "",
          loadAddr: document.state.header?.loadAddr ?? 0,
          entryPoint: document.state.header?.entryPoint ?? 0,
          dirty: opts?.dirty ?? document.isDirty
        }
      });
    };

    postState({ dirty: document.isDirty });

    webviewPanel.webview.onDidReceiveMessage(
      async (msg: { type: string; text?: string }) => {
        if (msg?.type === "requestInit") {
          postState({ dirty: document.isDirty });
          return;
        }

        // Let the webview trigger VS Code undo/redo so it uses our edit stack
        if (msg?.type === "undo") {
          await vscode.commands.executeCommand("undo");
          return;
        }
        if (msg?.type === "redo") {
          await vscode.commands.executeCommand("redo");
          return;
        }

        if (msg?.type === "edit" && typeof msg.text === "string") {
          const before = document.state.text;
          const after = msg.text;

          if (before === after) return;

          // Apply new text
          document.state.text = after;
          document.markDirty(true);

          // Fire edit event with undo/redo handlers
          this._onDidChangeCustomDocument.fire({
            document,
            label: "Edit boot.scr script",
            undo: async () => {
              document.state.text = before;
              document.markDirty(true);
              postState({ dirty: true });
            },
            redo: async () => {
              document.state.text = after;
              document.markDirty(true);
              postState({ dirty: true });
            }
          });

          return;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  async saveCustomDocument(document: BootScrDocument, cancellation: vscode.CancellationToken): Promise<void> {
    if (cancellation.isCancellationRequested) return;

    const baseHeader = document.state.header;

    const out = buildLegacyScriptImage({
      script: document.state.text,
      baseHeader,
      defaultName: baseHeader?.name ?? "boot script",
      defaultLoadAddr: baseHeader?.loadAddr ?? 0,
      defaultEntryPoint: baseHeader?.entryPoint ?? 0
    });

    await vscode.workspace.fs.writeFile(document.uri, out);
    document.markDirty(false);
  }

  async saveCustomDocumentAs(
    document: BootScrDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Promise<void> {
    if (cancellation.isCancellationRequested) return;

    const baseHeader = document.state.header;

    const out = buildLegacyScriptImage({
      script: document.state.text,
      baseHeader,
      defaultName: baseHeader?.name ?? "boot script",
      defaultLoadAddr: baseHeader?.loadAddr ?? 0,
      defaultEntryPoint: baseHeader?.entryPoint ?? 0
    });

    await vscode.workspace.fs.writeFile(destination, out);
    document.markDirty(false);
  }

  async revertCustomDocument(document: BootScrDocument, cancellation: vscode.CancellationToken): Promise<void> {
    if (cancellation.isCancellationRequested) return;

    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const parsed = parseLegacyUImage(new Uint8Array(bytes)); // strict

    document.state = {
      text: parsed.script,
      header: parsed.header
    };
    document.markDirty(false);

    // Tell VS Code content changed; this helps refresh state.
    this._onDidChangeCustomDocument.fire({ document });
  }

  async backupCustomDocument(
    document: BootScrDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const backupUri = context.destination;

    if (!cancellation.isCancellationRequested) {
      const baseHeader = document.state.header;

      const out = buildLegacyScriptImage({
        script: document.state.text,
        baseHeader,
        defaultName: baseHeader?.name ?? "boot script",
        defaultLoadAddr: baseHeader?.loadAddr ?? 0,
        defaultEntryPoint: baseHeader?.entryPoint ?? 0
      });

      await vscode.workspace.fs.writeFile(backupUri, out);
    }

    return {
      id: backupUri.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(backupUri);
        } catch {}
      }
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>U-Boot boot.scr</title>
  <style>
    body { padding: 0; margin: 0; }
    .bar {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(127,127,127,0.3);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      display:flex;
      gap:12px;
      align-items:center;
    }
    .pill { padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(127,127,127,0.35); }
    textarea {
      width: 100vw;
      height: calc(100vh - 40px);
      box-sizing: border-box;
      padding: 12px;
      border: none;
      outline: none;
      resize: none;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: var(--vscode-editor-line-height);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      tab-size: 2;
    }
    .dirty { border-top: 2px solid var(--vscode-testing-iconFailed, #d16969); }
  </style>
</head>
<body>
  <div class="bar">
    <span class="pill" id="meta">name: · load: · entry: ·</span>
    <span id="status">Ready</span>
  </div>

  <textarea id="editor" spellcheck="false"></textarea>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    const status = document.getElementById('status');
    const meta = document.getElementById('meta');

    let lastSent = '';
    let debounce = null;

    function setDirty(isDirty) {
      editor.classList.toggle('dirty', isDirty);
      status.textContent = isDirty ? 'Modified' : 'Saved';
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg?.type === 'init') {
        editor.value = msg.text ?? '';
        lastSent = editor.value;
        setDirty(!!msg?.meta?.dirty);

        meta.textContent =
          'name: ' + (msg?.meta?.name || 'n/a') +
          ' · load: 0x' + (Number(msg?.meta?.loadAddr || 0).toString(16)) +
          ' · entry: 0x' + (Number(msg?.meta?.entryPoint || 0).toString(16));
      }
    });

    // Route undo/redo through VS Code so it uses the provider edit stack.
    editor.addEventListener('keydown', (e) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      // Ctrl/Cmd+Z => undo
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        vscode.postMessage({ type: 'undo' });
        return;
      }

      // Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z => redo
      if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault();
        vscode.postMessage({ type: 'redo' });
        return;
      }
    });

    editor.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const text = editor.value;
        if (text !== lastSent) {
          lastSent = text;
          vscode.postMessage({ type: 'edit', text });
          setDirty(true);
        }
      }, 150);
    });

    vscode.postMessage({ type: 'requestInit' });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(BootScrEditorProvider.register(context));
}

export function deactivate() {}
