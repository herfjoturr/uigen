// ─────────────────────────────────────────────────────────────────────────────
// file_manager Tool
// ─────────────────────────────────────────────────────────────────────────────
// This is the second tool Claude can call during component generation.
// While str_replace_editor handles file content (create, read, edit),
// file_manager handles file system structure: renaming and deleting nodes.
//
// Separating these concerns mirrors how real IDEs work — there's a difference
// between editing a file's content and moving/removing the file itself.
// ─────────────────────────────────────────────────────────────────────────────

// tool() is a Vercel AI SDK helper that wraps a handler with zod schema validation.
// Using tool() (instead of a plain object) gives us better TypeScript integration
// and automatic argument parsing from Claude's JSON tool call output.
import { tool } from "ai";
import { z } from "zod";
import { VirtualFileSystem } from "../file-system";

// Factory: accepts the request-scoped VirtualFileSystem and returns a configured tool.
// The same pattern as buildStrReplaceTool — the tool closes over the FS instance
// so every tool call in the same conversation touches the same in-memory state.
export function buildFileManagerTool(fileSystem: VirtualFileSystem) {
  return tool({
    // Human-readable description that helps Claude understand when to call this tool
    // vs. str_replace_editor. Claude uses this description to make the right choice.
    description:
      'Rename or delete files or folders in the file system. Rename can be used to "move" a file. Rename will recursively create folders as required.',

    // Define the expected arguments using zod. The SDK validates Claude's JSON
    // against this schema before calling execute(), so we get runtime safety.
    parameters: z.object({
      // Only two operations are supported — keeps the tool focused and predictable.
      command: z
        .enum(["rename", "delete"])
        .describe("The operation to perform"),

      // The source path (file or directory to rename/delete).
      path: z
        .string()
        .describe("The path to the file or directory to rename or delete"),

      // Only needed for "rename". Making it optional means Claude doesn't have
      // to supply it for "delete" calls, reducing unnecessary tokens.
      new_path: z
        .string()
        .optional()
        .describe("The new path. Only provide when renaming or moving a file."),
    }),

    // execute() is called after the SDK validates the arguments.
    // It returns a plain object that gets serialised to JSON and sent back to Claude
    // as the tool result, so Claude can see whether the operation succeeded.
    execute: async ({ command, path, new_path }) => {
      if (command === "rename") {
        // Guard: new_path is logically required for rename even though the schema
        // marks it optional (to avoid requiring it for delete). Return a clear
        // error object rather than throwing, so Claude can read it and react.
        if (!new_path) {
          return {
            success: false,
            error: "new_path is required for rename command",
          };
        }

        // fileSystem.rename() handles moving the node in both the flat map and the
        // tree, and recursively updates paths of all descendants if it's a directory.
        const success = fileSystem.rename(path, new_path);
        if (success) {
          return {
            success: true,
            message: `Successfully renamed ${path} to ${new_path}`,
          };
        } else {
          return {
            success: false,
            error: `Failed to rename ${path} to ${new_path}`,
          };
        }
      } else if (command === "delete") {
        // fileSystem.deleteFile() works for both files and directories.
        // For directories it recurses through all children first.
        const success = fileSystem.deleteFile(path);
        if (success) {
          return { success: true, message: `Successfully deleted ${path}` };
        } else {
          return { success: false, error: `Failed to delete ${path}` };
        }
      }

      // Fallback — should never reach here because zod validates the enum,
      // but TypeScript requires an exhaustive return path.
      return { success: false, error: "Invalid command" };
    },
  });
}
