/** Undo/redo stack of { label, undo(), redo() } commands. */
export class History {
  constructor(limit = 80) {
    this.undos = [];
    this.redos = [];
    this.limit = limit;
    this.onChange = () => {};
  }

  push(cmd) {
    this.undos.push(cmd);
    if (this.undos.length > this.limit) this.undos.shift();
    this.redos.length = 0;
    this.onChange();
  }

  undo() {
    const cmd = this.undos.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redos.push(cmd);
    this.onChange();
    return cmd;
  }

  redo() {
    const cmd = this.redos.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undos.push(cmd);
    this.onChange();
    return cmd;
  }

  clear() {
    this.undos.length = 0;
    this.redos.length = 0;
    this.onChange();
  }

  get canUndo() { return this.undos.length > 0; }
  get canRedo() { return this.redos.length > 0; }
}
