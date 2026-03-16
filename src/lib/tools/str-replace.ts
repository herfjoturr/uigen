// ─────────────────────────────────────────────────────────────────────────────
// str_replace_editor Tool
// ─────────────────────────────────────────────────────────────────────────────
// This module builds the "str_replace_editor" tool that Claude calls during
// component generation. It follows Anthropic's standard text-editor tool
// interface so the tool name and parameter schema match what Claude was trained
// to use — meaning Claude already knows how to call it correctly without extra prompting.
//
// The tool is a factory function (buildStrReplaceTool) rather than a plain object
// because it needs a reference to the VirtualFileSystem instance created per request.
// That way every tool call in a conversation operates on the same in-memory FS.
// ─────────────────────────────────────────────────────────────────────────────

// zod is a TypeScript-first schema validation library.
// We use it to define and validate the shape of Claude's tool call arguments.
import { z } from "zod";
import { VirtualFileSystem } from "@/lib/file-system";

// Define the schema for every parameter Claude can send when calling this tool.
// zod validates the incoming JSON at runtime and TypeScript infers the types.
const TextEditorParameters = z.object({
  // "command" is the action Claude wants to perform:
  // - view:       show file contents (with optional line range)
  // - create:     create a new file with given content
  // - str_replace: find-and-replace a snippet inside a file
  // - insert:     insert text at a specific line number
  // - undo_edit:  not supported (Claude tries this sometimes; we return an error message)
  command: z.enum(["view", "create", "str_replace", "insert", "undo_edit"]),

  // Absolute path in the virtual file system, e.g. "/components/Button.jsx"
  path: z.string(),

  // Content for a newly created file (only used by "create").
  file_text: z.string().optional(),

  // Line number after which to insert new text (only used by "insert").
  insert_line: z.number().optional(),

  // The replacement string (used by both "str_replace" and "insert").
  new_str: z.string().optional(),

  // The exact snippet to find and replace (only used by "str_replace").
  old_str: z.string().optional(),

  // [startLine, endLine] for viewing only a portion of a file (only used by "view").
  view_range: z.array(z.number()).optional(),
});

// Factory function: takes a fileSystem instance and returns a fully configured tool object.
// The Vercel AI SDK expects a tool to have `parameters` (for validation) and `execute` (the handler).
export const buildStrReplaceTool = (fileSystem: VirtualFileSystem) => {
  return {
    // "id" is the name Claude uses in its tool call JSON.
    // This MUST match the string in the system prompt and in Claude's training.
    id: "str_replace_editor" as const,
    args: {},
    parameters: TextEditorParameters,

    // execute() is called by the Vercel AI SDK each time Claude emits a tool call
    // for "str_replace_editor". The SDK validates the args against TextEditorParameters
    // before calling this, so we can safely destructure without extra null checks.
    execute: async ({
      command,
      path,
      file_text,
      insert_line,
      new_str,
      old_str,
      view_range,
    }: z.infer<typeof TextEditorParameters>) => {
      switch (command) {
        // Show the file contents (or directory listing) back to Claude so it can
        // read what's already there before deciding what to write.
        case "view":
          return fileSystem.viewFile(
            path,
            view_range as [number, number] | undefined
          );

        // Create a brand-new file at `path` with `file_text` as its content.
        // createFileWithParents also creates any missing ancestor directories.
        case "create":
          return fileSystem.createFileWithParents(path, file_text || "");

        // Replace the exact `old_str` snippet with `new_str` inside the file.
        // This is Claude's primary editing strategy — surgical replacements instead
        // of rewriting whole files, which saves tokens and avoids accidental deletions.
        case "str_replace":
          return fileSystem.replaceInFile(path, old_str || "", new_str || "");

        // Insert `new_str` after line `insert_line` (0 = before the first line).
        // Useful for adding imports at the top or appending code at the end.
        case "insert":
          return fileSystem.insertInFile(path, insert_line || 0, new_str || "");

        // Claude sometimes tries to undo an edit, but we don't track history.
        // Return a descriptive error so Claude knows to use str_replace instead.
        case "undo_edit":
          return `Error: undo_edit command is not supported in this version. Use str_replace to revert changes.`;
      }
    },
  };
};
