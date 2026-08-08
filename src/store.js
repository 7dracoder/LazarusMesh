const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class JsonStore {
  constructor(filePath, createDefaultState) {
    this.filePath = filePath;
    this.createDefaultState = createDefaultState;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backup = `${this.filePath}.invalid-${Date.now()}`;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.copyFileSync(this.filePath, backup);
      }
      this.state = this.createDefaultState();
      this.save();
    }
    return this.state;
  }

  get() {
    return this.load();
  }

  replace(nextState) {
    this.state = nextState;
    this.save();
    return this.state;
  }

  update(mutator) {
    const state = this.load();
    const result = mutator(state);
    this.save();
    return result === undefined ? state : result;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* nothing to clean */ }
      throw error;
    }
  }
}

module.exports = { JsonStore };
