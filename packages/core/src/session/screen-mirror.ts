import { parsePicker } from '@ateam/contract';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as typeof import('@xterm/headless');

/**
 * What the CLI's screen shows right now, kept from the PTY stream. External
 * messages are pasted and submitted straight away (a busy CLI queues them
 * itself) EXCEPT while a dialog is up: there the Enter would answer it, e.g.
 * approve a permission prompt. The dialog test is the same picker parser the
 * UI uses to turn those menus into buttons.
 */
export class ScreenMirror {
  private readonly term: InstanceType<typeof Terminal>;
  private pending = 0;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(data: string): void {
    this.pending++;
    this.term.write(data, () => {
      this.pending--;
    });
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  /** true while output is still being parsed: the screen may be behind the PTY */
  get settling(): boolean {
    return this.pending > 0;
  }

  rows(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++)
      out.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    return out;
  }

  dialogVisible(): boolean {
    return parsePicker(this.rows()) !== null;
  }

  dispose(): void {
    this.term.dispose();
  }
}
