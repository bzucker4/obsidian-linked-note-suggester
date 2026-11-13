import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";

interface LinkedNoteSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxSuggestions: number;
  insertMode: "cursor" | "related-section";
  excludeFolders: string;
  minScore: number;
  useEmbeddings: boolean;
}

const DEFAULT_SETTINGS: LinkedNoteSettings = {
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "text-embedding-3-small",
  maxSuggestions: 5,
  insertMode: "related-section",
  excludeFolders: "",
  minScore: 0.15,
  useEmbeddings: false,
};

interface Suggestion {
  file: TFile;
  score: number;
  reason: string;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export default class LinkedNoteSuggester extends Plugin {
  settings: LinkedNoteSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "suggest-links",
      name: "Suggest links for current note",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        void this.suggestForView(view, editor);
      },
    });

    this.addRibbonIcon("link", "Suggest related notes", () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        void this.suggestForView(view, view.editor);
      } else {
        new Notice("Open a note first");
      }
    });

    this.addSettingTab(new LinkedNoteSettingTab(this.app, this));
  }

  async suggestForView(view: MarkdownView, editor: Editor) {
    const file = view.file;
    if (!file) {
      new Notice("No active file");
      return;
    }

    new Notice("Finding related notes…");

    const content = await this.app.vault.cachedRead(file);
    const suggestions = await this.findRelated(file, content);

    if (suggestions.length === 0) {
      new Notice("No related notes found");
      return;
    }

    new SuggestionModal(this.app, this, suggestions, editor, file).open();
  }

  async findRelated(current: TFile, content: string): Promise<Suggestion[]> {
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.path === current.path) return false;
      if (this.isExcluded(f.path)) return false;
      return true;
    });

    if (this.settings.useEmbeddings && this.settings.apiKey) {
      return this.findRelatedWithEmbeddings(current, content, files);
    }

    return this.findRelatedWithKeywords(current, content, files);
  }

  private isExcluded(path: string): boolean {
    const folders = this.settings.excludeFolders
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return folders.some((folder) => path.startsWith(folder));
  }

  private async findRelatedWithKeywords(
    current: TFile,
    content: string,
    files: TFile[]
  ): Promise<Suggestion[]> {
    const currentTokens = this.tokenize(content);
    const results: Suggestion[] = [];

    for (const file of files) {
      const text = await this.app.vault.cachedRead(file);
      const tokens = this.tokenize(text);
      const score = this.cosine(currentTokens, tokens);
      if (score >= this.settings.minScore) {
        const shared = this.topShared(currentTokens, tokens, 3);
        results.push({
          file,
          score,
          reason: shared.length ? `Shared: ${shared.join(", ")}` : "Similar content",
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.settings.maxSuggestions);
  }

  private async findRelatedWithEmbeddings(
    current: TFile,
    content: string,
    files: TFile[]
  ): Promise<Suggestion[]> {
    try {
      const currentEmb = await this.getEmbedding(content.slice(0, 8000));
      if (!currentEmb) return this.findRelatedWithKeywords(current, content, files);

      const results: Suggestion[] = [];
      for (const file of files.slice(0, 50)) {
        const text = await this.app.vault.cachedRead(file);
        const emb = await this.getEmbedding(text.slice(0, 4000));
        if (!emb) continue;
        const score = this.cosineVec(currentEmb, emb);
        if (score >= this.settings.minScore) {
          results.push({
            file,
            score,
            reason: `Similarity ${(score * 100).toFixed(0)}%`,
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, this.settings.maxSuggestions);
    } catch {
      new Notice("Embeddings failed, falling back to keywords");
      return this.findRelatedWithKeywords(current, content, files);
    }
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    const response = await requestUrl({
      url: `${this.settings.baseUrl}/embeddings`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify({
        model: this.settings.model,
        input: text,
      }),
    });

    if (response.status !== 200) return null;
    const data = response.json as EmbeddingResponse;
    return data.data?.[0]?.embedding ?? null;
  }

  private tokenize(text: string): Map<string, number> {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const map = new Map<string, number>();
    for (const w of words) {
      map.set(w, (map.get(w) || 0) + 1);
    }
    return map;
  }

  private cosine(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (const [k, v] of a) {
      magA += v * v;
      if (b.has(k)) dot += v * (b.get(k) || 0);
    }
    for (const v of b.values()) magB += v * v;
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  private cosineVec(a: number[], b: number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  private topShared(a: Map<string, number>, b: Map<string, number>, n: number): string[] {
    const shared: Array<{ word: string; score: number }> = [];
    for (const [k, v] of a) {
      if (b.has(k)) shared.push({ word: k, score: v + (b.get(k) || 0) });
    }
    shared.sort((x, y) => y.score - x.score);
    return shared.slice(0, n).map((s) => s.word);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SuggestionModal extends Modal {
  constructor(
    app: App,
    private plugin: LinkedNoteSuggester,
    private suggestions: Suggestion[],
    private editor: Editor,
    private currentFile: TFile
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("linked-note-modal");
    contentEl.createEl("h2", { text: "Related notes", cls: "modal-title" });

    const checks: Array<{ file: TFile; selected: boolean }> = [];

    for (const s of this.suggestions) {
      const row = contentEl.createDiv({ cls: "suggestion-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      const label = row.createEl("label");
      label.createEl("div", { text: s.file.basename });
      label.createEl("div", { text: s.reason, cls: "suggestion-reason" });
      label.prepend(cb);
      checks.push({ file: s.file, selected: true });

      cb.onchange = () => {
        const idx = checks.findIndex((c) => c.file === s.file);
        if (idx >= 0) checks[idx].selected = cb.checked;
      };
    }

    const buttonRow = contentEl.createDiv({ cls: "modal-button-row" });
    const insertBtn = buttonRow.createEl("button", { text: "Insert links" });
    insertBtn.onclick = () => {
      const selected = checks.filter((c) => c.selected).map((c) => c.file);
      this.insertLinks(selected);
      this.close();
    };

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();
  }

  private insertLinks(files: TFile[]) {
    if (files.length === 0) return;

    const links = files.map((f) => `[[${f.basename}]]`).join("\n");

    if (this.plugin.settings.insertMode === "cursor") {
      this.editor.replaceSelection(links + "\n");
    } else {
      const content = this.editor.getValue();
      const section = "\n\n## Related\n" + links + "\n";
      if (content.includes("## Related")) {
        this.editor.replaceRange(links + "\n", this.editor.getCursor());
      } else {
        this.editor.replaceRange(section, { line: this.editor.lineCount(), ch: 0 });
      }
    }

    new Notice(`Inserted ${files.length} link${files.length > 1 ? "s" : ""}`);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LinkedNoteSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LinkedNoteSuggester) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Use embeddings")
      .setDesc("Use an embeddings API for better results (requires API key). Falls back to keywords.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useEmbeddings).onChange(async (v) => {
          this.plugin.settings.useEmbeddings = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("For embeddings endpoint")
      .addText((text) =>
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Base URL")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .addText((text) =>
        text
          .setPlaceholder("text-embedding-3-small")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max suggestions")
      .addSlider((s) =>
        s
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxSuggestions)
          .onChange(async (v) => {
            this.plugin.settings.maxSuggestions = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Minimum score")
      .addSlider((s) =>
        s
          .setLimits(0.05, 0.5, 0.05)
          .setValue(this.plugin.settings.minScore)
          .onChange(async (v) => {
            this.plugin.settings.minScore = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Insert mode")
      .addDropdown((d) =>
        d
          .addOption("related-section", "Related section")
          .addOption("cursor", "At cursor")
          .setValue(this.plugin.settings.insertMode)
          .onChange(async (v: string) => {
            this.plugin.settings.insertMode = v as "cursor" | "related-section";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Comma-separated folder paths to skip")
      .addText((text) =>
        text
          .setPlaceholder("Templates, Archive")
          .setValue(this.plugin.settings.excludeFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
