import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** xterm owns ANSI parsing and drawing; networking never touches its internals. */
export function createTerminalView(element, { onInput, onResize }) {
  const terminal = new Terminal({ cols: 120, rows: 36, fontSize: 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', cursorBlink: true,
    disableStdin: true, scrollback: 3000, allowProposedApi: false,
    theme: { background: '#0d0e11', foreground: '#d8dbe2', cursor: '#c0c9d9', selectionBackground: '#384252' } });
  const addon = new FitAddon(), encoder = new TextEncoder();
  terminal.loadAddon(addon);
  terminal.open(element);
  const subscriptions = [
    terminal.onData(data => onInput(encoder.encode(data))),
    terminal.onBinary(data => onInput(Uint8Array.from(data, char => char.charCodeAt(0)))),
  ];
  const contextMenu = event => event.preventDefault();
  element.addEventListener('contextmenu', contextMenu);
  const geometry = () => ({ cols: terminal.cols, rows: terminal.rows });
  let disposed = false;
  function fit() {
    if (disposed) return geometry();
    const dimensions = addon.proposeDimensions();
    if (!dimensions) return geometry();
    const cols = Math.max(20, Math.min(500, dimensions.cols));
    const rows = Math.max(5, Math.min(300, dimensions.rows));
    if (terminal.cols !== cols || terminal.rows !== rows) {
      terminal.resize(cols, rows);
      onResize({ cols, rows });
    }
    return geometry();
  }
  let frame;
  const observer = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = undefined; fit(); });
  });
  observer.observe(element);
  document.fonts.ready.then(fit);
  return {
    geometry, fit,
    write: bytes => new Promise(resolve => terminal.write(bytes, resolve)),
    focus: () => terminal.focus(),
    reset: () => terminal.reset(),
    setInputEnabled: enabled => { terminal.options.disableStdin = !enabled; },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect(); cancelAnimationFrame(frame);
      element.removeEventListener('contextmenu', contextMenu);
      for (const subscription of subscriptions) subscription.dispose();
      terminal.dispose();
    },
  };
}
