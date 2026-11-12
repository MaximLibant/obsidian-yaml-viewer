import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { foldGutter, foldService } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  debounce,
  setIcon,
} from "obsidian";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
} from "yaml";

const VIEW_TYPE_YAML_VIEWER = "yaml-viewer";
const YAML_EXTENSIONS = ["yaml", "yml"];
const OUTLINE_MAX_DEPTH = 4;

interface OutlineItem {
  label: string;
  path: string;
  depth: number;
  type: "map" | "seq";
  count: number;
}

type ViewMode = "read" | "edit";

interface YamlViewerSettings {
  defaultMode: ViewMode;
  showComments: boolean;
}

interface ViewLayout {
  errors: HTMLElement;
  body: HTMLElement;
  tree: HTMLElement;
  search: HTMLInputElement;
  raw: HTMLDetailsElement;
  editButton: HTMLButtonElement;
  outlineItems: OutlineItem[];
}

export default class YamlViewerPlugin extends Plugin {
  settings: YamlViewerSettings = { defaultMode: "read", showComments: true };

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<YamlViewerSettings> | null;
    this.settings = {
      defaultMode: saved?.defaultMode === "edit" ? "edit" : "read",
      showComments: saved?.showComments !== false,
    };
    this.addSettingTab(new YamlViewerSettingTab(this.app, this));

    this.registerView(
      VIEW_TYPE_YAML_VIEWER,
      (leaf) => new YamlViewerView(leaf, this),
    );
    this.registerExtensions(YAML_EXTENSIONS, VIEW_TYPE_YAML_VIEWER);

    this.addCommand({
      id: "open-current-yaml-in-viewer",
      name: "Open current YAML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isYamlFile(file)) return false;

        if (!checking) {
          void this.openYamlFile(file);
        }
        return true;
      },
    });
  }

  async openYamlFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_YAML_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }

}

class YamlViewerSettingTab extends PluginSettingTab {
  private readonly plugin: YamlViewerPlugin;

  constructor(app: App, plugin: YamlViewerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Default view")
      .setDesc("The view a YAML file opens in. Edits are saved as typed and are never reformatted.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("read", "Read-only")
          .addOption("edit", "Read/write")
          .setValue(this.plugin.settings.defaultMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultMode = value === "edit" ? "edit" : "read";
            await this.plugin.saveData(this.plugin.settings);
          });
      });
    new Setting(this.containerEl)
      .setName("Show comments")
      .setDesc("Show YAML comments in the tree view.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showComments)
          .onChange(async (value) => {
            this.plugin.settings.showComments = value;
            await this.plugin.saveData(this.plugin.settings);
            this.app.workspace.getLeavesOfType(VIEW_TYPE_YAML_VIEWER).forEach((leaf) => {
              if (leaf.view instanceof YamlViewerView) leaf.view.renderTree();
            });
          });
      });
  }
}

class YamlViewerView extends TextFileView {
  private readonly plugin: YamlViewerPlugin;
  private readonly lock = new Compartment();
  private readonly refreshTree = debounce(() => this.renderTree(), 300, true);
  private editor: EditorView | null = null;
  private layout: ViewLayout | null = null;
  private editing = false;
  // null when the file mixes line endings. Saving would normalize them, so the file stays read-only.
  private lineSeparator: string | null = "\n";

  constructor(leaf: WorkspaceLeaf, plugin: YamlViewerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_YAML_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "YAML viewer";
  }

  getIcon(): string {
    return "braces";
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear || !this.editor) {
      this.render();
      return;
    }
    // Reached for external changes. A reload drops the cursor and undo history, so skip it when the text matches.
    if (data !== this.editor.state.sliceDoc()) {
      this.loadEditor();
      // The new text can mix line endings, which ends edit mode.
      if (this.editing) this.setEditing(true);
      this.renderTree();
    }
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.destroyEditor();
    this.layout = null;
    this.contentEl.empty();
  }

  protected async onClose(): Promise<void> {
    this.destroyEditor();
    await super.onClose();
  }

  // Edit mode shows the editor in place of the tree and outline.
  private setEditing(editing: boolean): void {
    if (!this.layout) return;
    if (editing && this.lineSeparator === null) {
      new Notice("This file mixes line endings, so it stays read-only.");
      editing = false;
    }
    this.editing = editing;
    this.editor?.dispatch({ effects: this.lock.reconfigure(this.lockExtension()) });
    this.contentEl.toggleClass("yaml-viewer--editing", editing);

    const { raw, editButton } = this.layout;
    raw.open = editing;
    const label = editing ? "Back to read view" : "Edit YAML";
    setIcon(editButton, editing ? "book-open" : "pencil");
    editButton.setAttribute("aria-label", label);
    editButton.title = label;
  }

  private lockExtension(): Extension {
    return [EditorState.readOnly.of(!this.editing), EditorView.editable.of(this.editing)];
  }

  private destroyEditor(): void {
    this.editor?.destroy();
    this.editor = null;
  }

  // Replaces the editor state with this.data, which drops the undo history.
  private loadEditor(): void {
    if (!this.layout) return;
    this.lineSeparator = detectLineSeparator(this.data);

    const state = EditorState.create({
      doc: this.data,
      extensions: [
        lineNumbers(),
        foldGutter(),
        foldService.of((state, lineStart) => yamlFoldRange(state.doc, lineStart)),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        yamlHighlighter,
        this.lineSeparator === null ? [] : EditorState.lineSeparator.of(this.lineSeparator),
        this.lock.of(this.lockExtension()),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // The text is saved as typed. Nothing is parsed and written back.
          this.data = update.state.sliceDoc();
          this.requestSave();
          this.refreshTree();
        }),
      ],
    });

    if (this.editor) {
      this.editor.setState(state);
    } else {
      this.editor = new EditorView({ state, parent: this.layout.raw });
    }
  }

  private render(): void {
    const container = this.contentEl;
    this.destroyEditor();
    container.empty();
    container.addClass("yaml-viewer");

    const header = container.createDiv({ cls: "yaml-viewer__header" });
    const title = header.createDiv({ cls: "yaml-viewer__title" });
    title.createDiv({
      cls: "yaml-viewer__filename",
      text: this.file?.name ?? "YAML file",
    });
    title.createDiv({
      cls: "yaml-viewer__path",
      text: this.file?.path ?? "",
    });

    const toolbar = header.createDiv({ cls: "yaml-viewer__toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "yaml-viewer__search" });
    setIcon(searchWrap.createSpan({ cls: "yaml-viewer__search-icon" }), "search");
    const searchInput = searchWrap.createEl("input", {
      attr: {
        "aria-label": "Filter YAML tree",
        placeholder: "Filter",
        spellcheck: "false",
        type: "search",
      },
    });
    const expandButton = createButton(toolbar, "chevrons-down", "Expand all");
    const collapseButton = createButton(toolbar, "chevrons-up", "Collapse all");
    const rawButton = createButton(toolbar, "file-code-2", "Copy raw YAML");
    const editButton = createButton(toolbar, "pencil", "Edit YAML");
    expandButton.addClass("yaml-viewer__tree-control");
    collapseButton.addClass("yaml-viewer__tree-control");

    rawButton.addEventListener("click", () => {
      void copyToClipboard(this.data, "YAML copied");
    });

    const errors = container.createDiv();
    const body = container.createDiv({ cls: "yaml-viewer__body" });
    const main = body.createDiv({ cls: "yaml-viewer__main" });
    const tree = main.createDiv({ cls: "yaml-viewer__tree" });
    const raw = main.createEl("details", { cls: "yaml-viewer__raw" });
    raw.createEl("summary", { text: "Raw YAML" });
    const layout: ViewLayout = { errors, body, tree, search: searchInput, raw, editButton, outlineItems: [] };
    this.layout = layout;

    editButton.addEventListener("click", () => {
      this.setEditing(!this.editing);
      if (this.editing) this.editor?.focus();
    });

    searchInput.addEventListener("input", () => {
      applyFilter(tree, layout.outlineItems, searchInput.value);
    });

    expandButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.setAttribute("open", "");
      });
    });

    collapseButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.removeAttribute("open");
      });
    });

    // The editor cannot measure itself while the details element is closed.
    raw.addEventListener("toggle", () => this.editor?.requestMeasure());
    this.loadEditor();
    this.setEditing(this.plugin.settings.defaultMode === "edit");

    this.renderTree();
  }

  // Rebuilds the parts derived from the text. The editor is left alone so typing keeps focus.
  renderTree(): void {
    if (!this.layout) return;
    const { errors, body, tree, search } = this.layout;
    errors.empty();
    tree.empty();
    body.querySelector(".yaml-viewer__outline")?.remove();
    this.layout.outlineItems = [];

    let documents: ReturnType<typeof parseAllDocuments> = [];
    try {
      documents = parseAllDocuments(this.data, {
        prettyErrors: true,
        strict: false,
        uniqueKeys: false,
      });
    } catch (error) {
      renderFatalError(errors, error);
      return;
    }

    const parseErrors = documents.flatMap((doc) => doc.errors);
    if (parseErrors.length > 0) {
      renderParseErrors(errors, parseErrors);
    }

    const outlineItems = this.layout.outlineItems;
    const { showComments } = this.plugin.settings;

    if (documents.length === 0 || documents.every((doc) => !doc.contents)) {
      tree.createDiv({
        cls: "yaml-viewer__empty",
        text: "This YAML file is empty.",
      });
    } else {
      documents.forEach((doc, index) => {
        const rootPath = documents.length > 1 ? `$[${index}]` : "$";
        if (documents.length > 1) {
          const docHeader = tree.createDiv({
            cls: "yaml-viewer__document-label",
            text: `Document ${index + 1}`,
          });
          docHeader.dataset.path = rootPath;
        }
        if (showComments) renderDocumentCommentBefore(tree, doc.commentBefore);
        outlineItems.push(...collectOutline(doc.contents, rootPath, documents.length > 1 ? `Document ${index + 1}` : "root", 0));
        renderNode(tree, doc.contents, rootPath, documents.length > 1 ? `Document ${index + 1}` : "root", showComments);
      });
    }

    renderOutline(body, tree, outlineItems);
    applyFilter(tree, outlineItems, search.value);
  }
}

function renderNode(parent: HTMLElement, node: unknown, path: string, label: string, showComments: boolean): void {
  if (node === null) {
    renderScalar(parent, label, null, path);
    return;
  }

  if (isMap(node)) {
    const details = createBranch(parent, label, path, "map", `${node.items.length} keys`);
    node.items.forEach((item) => renderPair(details, item, path, showComments));
    if (showComments) renderComment(details, node.comment);
    return;
  }

  if (isSeq(node)) {
    const details = createBranch(parent, label, path, "seq", `${node.items.length} items`);
    node.items.forEach((item, index) => {
      renderNode(details, item, `${path}[${index}]`, `[${index}]`, showComments);
    });
    if (showComments) renderComment(details, node.comment);
    return;
  }

  if (isAlias(node)) {
    renderScalar(parent, label, `*${node.source}`, path, "alias");
    return;
  }

  if (isScalar(node)) {
    renderScalar(parent, label, node.value, path);
    if (showComments) renderComment(parent, node.comment);
    return;
  }

  renderScalar(parent, label, formatValue(node), path);
}

function renderPair(
  parent: HTMLElement,
  pair: { key: unknown; value: unknown },
  parentPath: string,
  showComments: boolean,
): void {
  const keyText = stringifyKey(pair.key);
  const childPath = keyText.match(/^[A-Za-z_$][\w$-]*$/)
    ? `${parentPath}.${keyText}`
    : `${parentPath}[${JSON.stringify(keyText)}]`;
  renderNode(parent, pair.value, childPath, keyText, showComments);
}

function createBranch(
  parent: HTMLElement,
  label: string,
  path: string,
  type: string,
  meta: string,
): HTMLElement {
  const details = parent.createEl("details", {
    cls: `yaml-viewer__branch yaml-viewer__type-${type}`,
    attr: { open: "" },
  });
  details.dataset.path = path;

  const summary = details.createEl("summary", { cls: "yaml-viewer__row" });
  summary.createSpan({ cls: "yaml-viewer__key", text: label });
  summary.createSpan({ cls: "yaml-viewer__badge", text: type });
  summary.createSpan({ cls: "yaml-viewer__meta", text: meta });
  addCopyPathButton(summary, path);

  return details;
}

function renderScalar(
  parent: HTMLElement,
  label: string,
  value: unknown,
  path: string,
  forcedType?: string,
): void {
  const type = forcedType ?? valueType(value);
  const row = parent.createDiv({ cls: "yaml-viewer__row yaml-viewer__leaf" });
  row.addClass(`yaml-viewer__type-${type}`);
  row.dataset.path = path;
  row.createSpan({ cls: "yaml-viewer__key", text: label });
  row.createSpan({ cls: "yaml-viewer__value", text: formatValue(value) });
  addCopyPathButton(row, path);
}

function addCopyPathButton(parent: HTMLElement, path: string): void {
  const button = createButton(parent, "copy", "Copy YAML path");
  button.addClass("yaml-viewer__copy");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copyToClipboard(path, `Copied ${path}`);
  });
}

function renderParseErrors(parent: HTMLElement, errors: Error[]): void {
  const box = parent.createDiv({ cls: "yaml-viewer__errors" });
  box.createDiv({ cls: "yaml-viewer__errors-title", text: "Parse warnings/errors" });
  errors.forEach((error) => {
    box.createDiv({ cls: "yaml-viewer__error", text: error.message });
  });
}

function renderFatalError(parent: HTMLElement, error: unknown): void {
  const box = parent.createDiv({ cls: "yaml-viewer__errors" });
  box.createDiv({ cls: "yaml-viewer__errors-title", text: "Could not parse YAML" });
  box.createDiv({ cls: "yaml-viewer__error", text: getErrorMessage(error) });
}

function renderComment(parent: HTMLElement, comment: string | null | undefined): void {
  if (!comment) return;
  parent.createDiv({ cls: "yaml-viewer__comment", text: `# ${comment.trim()}` });
}

function renderDocumentCommentBefore(parent: HTMLElement, comment: string | null | undefined): void {
  if (!comment) return;
  const block = parent.createDiv({ cls: "yaml-viewer__document-comments" });
  comment.split("\n").forEach((line) => {
    block.createDiv({
      cls: "yaml-viewer__document-comment",
      text: `#${line}`,
    });
  });
}

function createButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon yaml-viewer__button",
    attr: { "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

async function copyToClipboard(text: string, notice: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(notice);
}

function stringifyKey(key: unknown): string {
  if (isScalar(key)) {
    return String(key.value);
  }
  if (key === null || key === undefined) {
    return "null";
  }
  return formatValue(key);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isYamlFile(file: TFile | null): file is TFile {
  return file instanceof TFile && YAML_EXTENSIONS.includes(file.extension.toLowerCase());
}

function collectOutline(
  node: unknown,
  path: string,
  label: string,
  depth: number,
): OutlineItem[] {
  if (depth > OUTLINE_MAX_DEPTH) return [];
  if (!isMap(node) && !isSeq(node)) return [];

  const type = isMap(node) ? "map" : "seq";
  const count = node.items.length;
  const items: OutlineItem[] = [{ label, path, depth, type, count }];

  if (depth === OUTLINE_MAX_DEPTH) return items;

  if (isMap(node)) {
    node.items.forEach((item) => {
      const childLabel = stringifyKey(item.key);
      const childPath = childLabel.match(/^[A-Za-z_$][\w$-]*$/)
        ? `${path}.${childLabel}`
        : `${path}[${JSON.stringify(childLabel)}]`;
      items.push(...collectOutline(item.value, childPath, childLabel, depth + 1));
    });
  } else {
    node.items.forEach((item, index) => {
      if (!isMap(item) && !isSeq(item)) return;
      items.push(...collectOutline(item, `${path}[${index}]`, `[${index}]`, depth + 1));
    });
  }

  return items;
}

function renderOutline(parent: HTMLElement, tree: HTMLElement, items: OutlineItem[]): void {
  const aside = parent.createEl("aside", { cls: "yaml-viewer__outline" });
  aside.createDiv({ cls: "yaml-viewer__outline-title", text: "Outline" });

  if (items.length === 0) {
    aside.createDiv({ cls: "yaml-viewer__outline-empty", text: "No structure" });
    return;
  }

  items.forEach((item) => {
    const button = aside.createEl("button", {
      cls: "yaml-viewer__outline-item",
      attr: {
        "aria-label": `Go to ${item.path}`,
        type: "button",
      },
    });
    button.dataset.path = item.path;
    button.style.setProperty("--yaml-viewer-outline-depth", String(item.depth));
    button.createSpan({ cls: "yaml-viewer__outline-label", text: item.label });
    button.createSpan({ cls: "yaml-viewer__outline-meta", text: `${item.count}` });
    button.addEventListener("click", () => {
      const target = findPathElement(tree, item.path);
      if (!target) return;
      openAncestors(target);
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.addClass("yaml-viewer__pulse");
      window.setTimeout(() => target.removeClass("yaml-viewer__pulse"), 900);
    });
  });
}

function applyFilter(tree: HTMLElement, outlineItems: OutlineItem[], query: string): void {
  const needle = query.trim().toLowerCase();
  const nodes = Array.from(tree.querySelectorAll<HTMLElement>("[data-path]"));
  const outline = tree.parentElement?.parentElement?.querySelector<HTMLElement>(".yaml-viewer__outline");
  const outlineButtons = Array.from(outline?.querySelectorAll<HTMLButtonElement>(".yaml-viewer__outline-item") ?? []);

  if (!needle) {
    nodes.forEach((node) => {
      node.removeClass("yaml-viewer__hidden");
      node.removeClass("yaml-viewer__match");
    });
    outlineButtons.forEach((button) => button.removeClass("yaml-viewer__hidden"));
    return;
  }

  const visiblePaths = new Set<string>();
  const matchingPaths = new Set<string>();

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    const haystack = `${path} ${node.textContent ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return;
    matchingPaths.add(path);
    visiblePaths.add(path);
    addAncestorPaths(path, visiblePaths);
  });

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    node.toggleClass("yaml-viewer__hidden", !visiblePaths.has(path));
    node.toggleClass("yaml-viewer__match", matchingPaths.has(path));
    if (visiblePaths.has(path)) openAncestors(node);
  });

  outlineButtons.forEach((button) => {
    const path = button.dataset.path ?? "";
    const item = outlineItems.find((outlineItem) => outlineItem.path === path);
    const haystack = `${path} ${item?.label ?? ""}`.toLowerCase();
    button.toggleClass("yaml-viewer__hidden", !haystack.includes(needle));
  });
}

function addAncestorPaths(path: string, paths: Set<string>): void {
  let current = path;
  while (current !== "$") {
    current = parentPath(current);
    paths.add(current);
  }
}

function parentPath(path: string): string {
  if (path.endsWith("]")) {
    const bracket = path.lastIndexOf("[");
    if (bracket > 0) return path.slice(0, bracket);
  }
  const dot = path.lastIndexOf(".");
  if (dot > 0) return path.slice(0, dot);
  return "$";
}

function findPathElement(tree: HTMLElement, path: string): HTMLElement | undefined {
  return Array.from(tree.querySelectorAll<HTMLElement>("[data-path]")).find((element) => {
    return element.dataset.path === path;
  });
}

function openAncestors(element: HTMLElement): void {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.instanceOf(HTMLDetailsElement)) current.open = true;
    current = current.parentElement;
  }
}

// Returns null for mixed line endings, which the editor cannot write back unchanged.
function detectLineSeparator(text: string): string | null {
  if (!text.includes("\r")) return "\n";
  return /\r(?!\n)|(?<!\r)\n/.test(text) ? null : "\r\n";
}

const TOKEN_MARKS = {
  key: Decoration.mark({ class: "yaml-viewer__tok-key" }),
  punctuation: Decoration.mark({ class: "yaml-viewer__tok-punctuation" }),
  string: Decoration.mark({ class: "yaml-viewer__tok-string" }),
  number: Decoration.mark({ class: "yaml-viewer__tok-number" }),
  boolean: Decoration.mark({ class: "yaml-viewer__tok-boolean" }),
  null: Decoration.mark({ class: "yaml-viewer__tok-null" }),
  collection: Decoration.mark({ class: "yaml-viewer__tok-collection" }),
  comment: Decoration.mark({ class: "yaml-viewer__tok-comment" }),
};

type TokenType = keyof typeof TOKEN_MARKS;

interface YamlToken {
  from: number;
  to: number;
  type: TokenType;
}

const yamlHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = highlightVisibleLines(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = highlightVisibleLines(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function highlightVisibleLines(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // CodeMirror can split one very long line across two visible ranges. Visiting it twice would
  // add ranges out of order, which the builder rejects.
  let nextLineStart = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = Math.max(from, nextLineStart); pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const token of tokenizeYamlLine(line.text)) {
        builder.add(line.from + token.from, line.from + token.to, TOKEN_MARKS[token.type]);
      }
      pos = line.to + 1;
      nextLineStart = pos;
    }
  }
  return builder.finish();
}

// Tokens are non-empty and in source order, as the range builder requires.
function tokenizeYamlLine(line: string): YamlToken[] {
  if (line.trimStart().startsWith("#")) {
    return [{ from: 0, to: line.length, type: "comment" }];
  }

  const tokens: YamlToken[] = [];
  const hashIndex = findCommentStart(line);
  const codePart = hashIndex >= 0 ? line.slice(0, hashIndex) : line;
  const keyMatch = codePart.match(/^(\s*(?:-\s*)?)([^:#\n][^:\n]*?)(\s*:\s*)(.*)$/);

  let valueStart = 0;
  if (keyMatch) {
    const keyStart = keyMatch[1].length;
    const punctuationStart = keyStart + keyMatch[2].length;
    valueStart = punctuationStart + keyMatch[3].length;
    tokens.push({ from: keyStart, to: punctuationStart, type: "key" });
    tokens.push({ from: punctuationStart, to: valueStart, type: "punctuation" });
  }

  const value = codePart.slice(valueStart);
  const trimmed = value.trim();
  if (trimmed) {
    const from = valueStart + value.length - value.trimStart().length;
    tokens.push({ from, to: from + trimmed.length, type: tokenType(trimmed) });
  }

  if (hashIndex >= 0) {
    tokens.push({ from: hashIndex, to: line.length, type: "comment" });
  }

  return tokens;
}

function tokenType(value: string): TokenType {
  if (/^["'].*["']$/.test(value)) return "string";
  if (/^(true|false)$/i.test(value)) return "boolean";
  if (/^(null|~)$/i.test(value)) return "null";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return "collection";
  }
  return "string";
}

// Folds a block by indentation. A key ending in ":" also takes "- " items at its own indentation.
function yamlFoldRange(doc: Text, lineStart: number): { from: number; to: number } | null {
  const header = doc.lineAt(lineStart);
  const headerIndent = indentOf(header.text);
  if (headerIndent === null) return null;

  const commentStart = findCommentStart(header.text);
  const code = (commentStart >= 0 ? header.text.slice(0, commentStart) : header.text).trimEnd();
  const takesSameIndentItems = code.endsWith(":") && !isSequenceItem(code.slice(headerIndent));

  let to = header.to;
  for (let number = header.number + 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const indent = indentOf(line.text);
    if (indent === null) continue;
    const inBlock = indent > headerIndent
      || (takesSameIndentItems && indent === headerIndent && isSequenceItem(line.text.slice(indent)));
    if (!inBlock) break;
    to = line.to;
  }
  return to > header.to ? { from: header.to, to } : null;
}

// Returns null for blank lines.
function indentOf(line: string): number | null {
  const indent = line.length - line.trimStart().length;
  return indent === line.length ? null : indent;
}

// A bare "-" prefix would also match the "---" document separator.
function isSequenceItem(text: string): boolean {
  return /^-(\s|$)/.test(text);
}

function findCommentStart(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "'" || character === "\"") && line[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(line[index - 1]))) {
      return index;
    }
  }
  return -1;
}
