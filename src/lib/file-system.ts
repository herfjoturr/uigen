// ─────────────────────────────────────────────────────────────────────────────
// Virtual File System
// ─────────────────────────────────────────────────────────────────────────────
// This module simulates a real file system entirely in memory (no disk I/O).
// Why? Because Claude generates files during a conversation, and we don't want
// to actually write those files to the server's disk. Keeping everything in
// memory is safe, fast, and easy to serialize into the database as JSON.
//
// Data structure: a tree of FileNode objects.
// - Each directory node has a `children` Map (name → FileNode).
// - A flat `files` Map (absolute path → FileNode) is kept in parallel so any
//   node can be looked up in O(1) by its path without traversing the tree.
// ─────────────────────────────────────────────────────────────────────────────

// FileNode is the building block of the tree.
// A node is either a "file" (has content) or a "directory" (has children).
export interface FileNode {
  type: "file" | "directory";
  name: string;   // just the filename, e.g. "App.jsx"
  path: string;   // absolute path, e.g. "/components/App.jsx"
  content?: string;              // only present on file nodes
  children?: Map<string, FileNode>; // only present on directory nodes
}

export class VirtualFileSystem {
  // Fast lookup: absolute path → node. Used by every read/write operation.
  private files: Map<string, FileNode> = new Map();
  // The root directory node. Every other node lives inside it (directly or nested).
  private root: FileNode;

  constructor() {
    // Bootstrap the file system with a single root directory at "/".
    // Without a root, there is no valid parent for any top-level file.
    this.root = {
      type: "directory",
      name: "/",
      path: "/",
      children: new Map(),
    };
    // Register root in the flat map so path-based lookups work immediately.
    this.files.set("/", this.root);
  }

  // ── Path Utilities ──────────────────────────────────────────────────────────

  // Ensure all paths have a consistent format before any operation.
  // Consistent paths prevent bugs like "/foo" vs "foo" referring to different nodes.
  private normalizePath(path: string): string {
    // Guarantee the path starts with a slash (absolute path convention).
    if (!path.startsWith("/")) {
      path = "/" + path;
    }
    // Remove trailing slash except for root, so "/foo/" and "/foo" are the same.
    if (path !== "/" && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    // Collapse "//" into "/" — handles sloppy input like "//components//App.jsx".
    path = path.replace(/\/+/g, "/");
    return path;
  }

  // Returns the parent directory's path.
  // e.g. "/components/Button.jsx" → "/components"
  //      "/App.jsx"               → "/"
  private getParentPath(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/");
    parts.pop(); // remove the file/dir name
    // If only one empty string remains after splitting "/" → parent is root.
    return parts.length === 1 ? "/" : parts.join("/");
  }

  // Extracts just the final segment (filename or directory name) from a path.
  // e.g. "/components/Button.jsx" → "Button.jsx"
  private getFileName(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";
    const parts = normalized.split("/");
    return parts[parts.length - 1];
  }

  // Looks up the parent directory node for a given path.
  // Returns null if the parent doesn't exist (operation should fail gracefully).
  private getParentNode(path: string): FileNode | null {
    const parentPath = this.getParentPath(path);
    return this.files.get(parentPath) || null;
  }

  // ── Write Operations ────────────────────────────────────────────────────────

  // Creates a new file at `path` with optional initial `content`.
  // Also creates any missing parent directories automatically so Claude
  // can write "/components/Button.jsx" even if "/components" doesn't exist yet.
  createFile(path: string, content: string = ""): FileNode | null {
    const normalized = this.normalizePath(path);

    // Idempotency guard: return null instead of overwriting an existing node.
    if (this.files.has(normalized)) {
      return null;
    }

    // Walk the path segments (excluding the filename) and create each missing directory.
    // e.g. for "/a/b/c.jsx" we ensure "/a" and "/a/b" exist before creating the file.
    const parts = normalized.split("/").filter(Boolean);
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += "/" + parts[i];
      if (!this.exists(currentPath)) {
        this.createDirectory(currentPath);
      }
    }

    const parent = this.getParentNode(normalized);
    // Sanity check: parent must exist and be a directory, not a file.
    if (!parent || parent.type !== "directory") {
      return null;
    }

    const fileName = this.getFileName(normalized);
    const file: FileNode = {
      type: "file",
      name: fileName,
      path: normalized,
      content,
    };

    // Register in both the flat map (fast lookup) and the parent's children map (tree structure).
    this.files.set(normalized, file);
    parent.children!.set(fileName, file);

    return file;
  }

  // Creates a directory node. Follows the same pattern as createFile.
  // Directories don't have content — only a children map.
  createDirectory(path: string): FileNode | null {
    const normalized = this.normalizePath(path);

    if (this.files.has(normalized)) {
      return null;
    }

    const parent = this.getParentNode(normalized);
    if (!parent || parent.type !== "directory") {
      return null;
    }

    const dirName = this.getFileName(normalized);
    const directory: FileNode = {
      type: "directory",
      name: dirName,
      path: normalized,
      children: new Map(), // empty — no files yet
    };

    this.files.set(normalized, directory);
    parent.children!.set(dirName, directory);

    return directory;
  }

  // ── Read Operations ─────────────────────────────────────────────────────────

  // Returns a file's text content, or null if the path doesn't exist / is a directory.
  readFile(path: string): string | null {
    const normalized = this.normalizePath(path);
    const file = this.files.get(normalized);

    if (!file || file.type !== "file") {
      return null;
    }

    // content may be undefined for freshly created empty files; normalise to "".
    return file.content || "";
  }

  // ── Update Operations ────────────────────────────────────────────────────────

  // Replaces a file's entire content. Returns false if the path is invalid.
  // Claude's str_replace tool ultimately calls this after computing the new content.
  updateFile(path: string, content: string): boolean {
    const normalized = this.normalizePath(path);
    const file = this.files.get(normalized);

    if (!file || file.type !== "file") {
      return false;
    }

    // Mutate in place — the same object reference is already in both maps,
    // so every consumer that holds a reference to this node sees the new content.
    file.content = content;
    return true;
  }

  // ── Delete Operations ────────────────────────────────────────────────────────

  // Deletes a file or directory (recursively for directories).
  // Removing from both maps keeps the two data structures in sync.
  deleteFile(path: string): boolean {
    const normalized = this.normalizePath(path);
    const file = this.files.get(normalized);

    // Disallow deleting non-existent nodes or the root (would break everything).
    if (!file || normalized === "/") {
      return false;
    }

    const parent = this.getParentNode(normalized);
    if (!parent || parent.type !== "directory") {
      return false;
    }

    // Recursively delete all children before removing the directory itself.
    // Without this, the flat `files` map would still hold stale child entries.
    if (file.type === "directory" && file.children) {
      for (const [_, child] of file.children) {
        this.deleteFile(child.path);
      }
    }

    // Detach from parent's children map and remove from flat lookup map.
    parent.children!.delete(file.name);
    this.files.delete(normalized);

    return true;
  }

  // ── Rename / Move ────────────────────────────────────────────────────────────

  // Moves a file or directory from oldPath to newPath.
  // This is also how "move" is implemented — rename with a different parent path.
  rename(oldPath: string, newPath: string): boolean {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);

    // Root cannot be renamed; that would corrupt the entire file system.
    if (normalizedOld === "/" || normalizedNew === "/") {
      return false;
    }

    const sourceNode = this.files.get(normalizedOld);
    if (!sourceNode) {
      return false;
    }

    // Prevent overwriting an existing node at the destination.
    if (this.files.has(normalizedNew)) {
      return false;
    }

    const oldParent = this.getParentNode(normalizedOld);
    if (!oldParent || oldParent.type !== "directory") {
      return false;
    }

    // Create the destination's parent directories if they don't exist yet.
    // e.g. moving "/Button.jsx" to "/components/ui/Button.jsx" auto-creates the dirs.
    const newParentPath = this.getParentPath(normalizedNew);
    if (!this.exists(newParentPath)) {
      const parts = newParentPath.split("/").filter(Boolean);
      let currentPath = "";

      for (const part of parts) {
        currentPath += "/" + part;
        if (!this.exists(currentPath)) {
          this.createDirectory(currentPath);
        }
      }
    }

    const newParent = this.getParentNode(normalizedNew);
    if (!newParent || newParent.type !== "directory") {
      return false;
    }

    // Unlink the node from its old parent.
    oldParent.children!.delete(sourceNode.name);

    // Update the node's metadata to reflect its new location.
    const newName = this.getFileName(normalizedNew);
    sourceNode.name = newName;
    sourceNode.path = normalizedNew;

    // Attach to the new parent.
    newParent.children!.set(newName, sourceNode);

    // Update the flat lookup map (remove old key, add new key).
    this.files.delete(normalizedOld);
    this.files.set(normalizedNew, sourceNode);

    // If renaming a directory, all its descendants inherit a new path prefix.
    // updateChildrenPaths fixes every child's path in the flat map recursively.
    if (sourceNode.type === "directory" && sourceNode.children) {
      this.updateChildrenPaths(sourceNode);
    }

    return true;
  }

  // After a directory is renamed, every descendant's absolute path changes.
  // This recursive helper walks the subtree and re-keys each node in the flat map.
  private updateChildrenPaths(node: FileNode): void {
    if (node.type === "directory" && node.children) {
      for (const [_, child] of node.children) {
        const oldChildPath = child.path;
        // New path = parent's new path + "/" + the child's unchanged name.
        child.path = node.path + "/" + child.name;

        // Swap the old path key for the new one in the flat map.
        this.files.delete(oldChildPath);
        this.files.set(child.path, child);

        // Recurse into subdirectories.
        if (child.type === "directory") {
          this.updateChildrenPaths(child);
        }
      }
    }
  }

  // ── Query Helpers ────────────────────────────────────────────────────────────

  // O(1) existence check — just looks up the flat map.
  exists(path: string): boolean {
    const normalized = this.normalizePath(path);
    return this.files.has(normalized);
  }

  // Returns the raw FileNode (or null). Useful when you need both the content
  // and the metadata (type, name, path) in one call.
  getNode(path: string): FileNode | null {
    const normalized = this.normalizePath(path);
    return this.files.get(normalized) || null;
  }

  // Returns the immediate children of a directory as an array.
  // Used by the FileTree UI component to render directory contents.
  listDirectory(path: string): FileNode[] | null {
    const normalized = this.normalizePath(path);
    const dir = this.files.get(normalized);

    if (!dir || dir.type !== "directory") {
      return null;
    }

    return Array.from(dir.children?.values() || []);
  }

  // Returns a flat Map of every file path → content.
  // The preview iframe uses this to bundle all files at once.
  getAllFiles(): Map<string, string> {
    const fileMap = new Map<string, string>();

    for (const [path, node] of this.files) {
      if (node.type === "file") {
        fileMap.set(path, node.content || "");
      }
    }

    return fileMap;
  }

  // ── Serialization ────────────────────────────────────────────────────────────

  // Converts the file system to a plain JSON-serializable object so it can be
  // stored in the database (Project.data column) or sent over HTTP.
  // Maps are not JSON-serializable, so we omit the `children` Map from directory nodes.
  // When deserializing, the children Maps are reconstructed from the flat path keys.
  serialize(): Record<string, FileNode> {
    const result: Record<string, FileNode> = {};

    for (const [path, node] of this.files) {
      if (node.type === "directory") {
        // Strip `children` (a Map) — it will be rebuilt during deserialization.
        result[path] = {
          type: node.type,
          name: node.name,
          path: node.path,
        };
      } else {
        result[path] = {
          type: node.type,
          name: node.name,
          path: node.path,
          content: node.content,
        };
      }
    }

    return result;
  }

  // Restores the file system from a simple { path: content } map.
  // Used by legacy/simple data formats (not the primary path today).
  deserialize(data: Record<string, string>): void {
    // Reset to a blank slate before importing — avoids ghost files.
    this.files.clear();
    this.root.children?.clear();
    this.files.set("/", this.root);

    // Sort paths alphabetically so parent directories come before their children.
    // e.g. "/components" is created before "/components/Button.jsx".
    const paths = Object.keys(data).sort();

    for (const path of paths) {
      const parts = path.split("/").filter(Boolean);
      let currentPath = "";

      // Ensure all ancestor directories exist before creating the file.
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += "/" + parts[i];
        if (!this.exists(currentPath)) {
          this.createDirectory(currentPath);
        }
      }

      this.createFile(path, data[path]);
    }
  }

  // Restores the file system from the richer FileNode format produced by serialize().
  // This is what the API route and ChatContext use to hydrate the FS from the DB.
  deserializeFromNodes(data: Record<string, FileNode>): void {
    this.files.clear();
    this.root.children?.clear();
    this.files.set("/", this.root);

    // Sort ensures parents are created before children (lexicographic order works
    // because "/" < any letter, so "/a" always sorts before "/a/b").
    const paths = Object.keys(data).sort();

    for (const path of paths) {
      if (path === "/") continue; // Root already exists; skip it.

      const node = data[path];
      const parts = path.split("/").filter(Boolean);
      let currentPath = "";

      // Recreate missing parent directories (same logic as deserialize).
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += "/" + parts[i];
        if (!this.exists(currentPath)) {
          this.createDirectory(currentPath);
        }
      }

      // Recreate the node with its original type and content.
      if (node.type === "file") {
        this.createFile(path, node.content || "");
      } else if (node.type === "directory") {
        this.createDirectory(path);
      }
    }
  }

  // ── Text Editor Command Implementations ──────────────────────────────────────
  // The methods below mirror the Claude "text editor" tool commands.
  // They return human-readable strings so Claude can read the result and react.

  // Shows a file's content with 1-based line numbers, or lists a directory.
  // viewRange allows Claude to request a specific slice of a large file.
  viewFile(path: string, viewRange?: [number, number]): string {
    const file = this.getNode(path);
    if (!file) {
      return `File not found: ${path}`;
    }

    // If the path points to a directory, return a formatted listing instead.
    if (file.type === "directory") {
      const children = this.listDirectory(path);
      if (!children || children.length === 0) {
        return "(empty directory)";
      }

      return children
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((child) => {
          const prefix = child.type === "directory" ? "[DIR]" : "[FILE]";
          return `${prefix} ${child.name}`;
        })
        .join("\n");
    }

    const content = file.content || "";

    // If viewRange is provided, return only those lines (1-indexed).
    // -1 as the end means "through the last line".
    if (viewRange && viewRange.length === 2) {
      const lines = content.split("\n");
      const [start, end] = viewRange;
      const startLine = Math.max(1, start);
      const endLine = end === -1 ? lines.length : Math.min(lines.length, end);

      const viewedLines = lines.slice(startLine - 1, endLine);
      // Format: "lineNumber\tcontent" — matches the convention Claude was trained on.
      return viewedLines
        .map((line, index) => `${startLine + index}\t${line}`)
        .join("\n");
    }

    // Return the full file with line numbers so Claude can reference specific lines.
    const lines = content.split("\n");
    return (
      lines.map((line, index) => `${index + 1}\t${line}`).join("\n") ||
      "(empty file)"
    );
  }

  // Creates a new file, automatically creating any missing parent directories.
  // Returns an error string (not an exception) so Claude can handle it gracefully.
  createFileWithParents(path: string, content: string = ""): string {
    if (this.exists(path)) {
      return `Error: File already exists: ${path}`;
    }

    // Walk the ancestor directories and create any that are missing.
    const parts = path.split("/").filter(Boolean);
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath += "/" + parts[i];
      if (!this.exists(currentPath)) {
        this.createDirectory(currentPath);
      }
    }

    this.createFile(path, content);
    return `File created: ${path}`;
  }

  // Finds `oldStr` inside the file at `path` and replaces every occurrence with `newStr`.
  // This is the core of Claude's "str_replace" editing strategy: instead of rewriting
  // entire files, Claude identifies a unique snippet to replace — much more token-efficient.
  replaceInFile(path: string, oldStr: string, newStr: string): string {
    const file = this.getNode(path);
    if (!file) {
      return `Error: File not found: ${path}`;
    }

    if (file.type !== "file") {
      return `Error: Cannot edit a directory: ${path}`;
    }

    const content = this.readFile(path) || "";

    // If the string to replace isn't found, tell Claude so it can try again
    // with a different snippet rather than silently producing wrong output.
    if (!oldStr || !content.includes(oldStr)) {
      return `Error: String not found in file: "${oldStr}"`;
    }

    // Count how many times the old string appears so Claude gets feedback.
    const occurrences = (
      content.match(
        // Escape regex special characters so the literal string is matched.
        new RegExp(oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      ) || []
    ).length;

    // Replace ALL occurrences (split/join is simpler and avoids regex flags).
    const updatedContent = content.split(oldStr).join(newStr || "");
    this.updateFile(path, updatedContent);

    return `Replaced ${occurrences} occurrence(s) of the string in ${path}`;
  }

  // Inserts `text` after line number `insertLine` (0 = before the first line).
  // Useful when Claude wants to add new code without touching existing lines.
  insertInFile(path: string, insertLine: number, text: string): string {
    const file = this.getNode(path);
    if (!file) {
      return `Error: File not found: ${path}`;
    }

    if (file.type !== "file") {
      return `Error: Cannot edit a directory: ${path}`;
    }

    const content = this.readFile(path) || "";
    const lines = content.split("\n");

    // Guard against out-of-range line numbers to prevent corrupting the file.
    if (
      insertLine === undefined ||
      insertLine < 0 ||
      insertLine > lines.length
    ) {
      return `Error: Invalid line number: ${insertLine}. File has ${lines.length} lines.`;
    }

    // splice(index, 0, item) inserts without removing anything.
    lines.splice(insertLine, 0, text || "");
    const updatedContent = lines.join("\n");
    this.updateFile(path, updatedContent);

    return `Text inserted at line ${insertLine} in ${path}`;
  }

  // Clears all files and resets to a fresh file system with only the root directory.
  // Called when the user starts a new project or clears the current one.
  reset(): void {
    this.files.clear();
    this.root = {
      type: "directory",
      name: "/",
      path: "/",
      children: new Map(),
    };
    this.files.set("/", this.root);
  }
}

// A singleton instance exported for convenience in contexts that don't need
// the server-side per-request isolation (e.g., simple utility scripts).
// The main app creates its own instance per session via FileSystemContext.
export const fileSystem = new VirtualFileSystem();
