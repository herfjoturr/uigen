// This is the main API endpoint that handles all AI chat requests.
// It runs exclusively on the server (Next.js Route Handler), so secrets like
// ANTHROPIC_API_KEY are never exposed to the browser.

import type { FileNode } from "@/lib/file-system";
import { VirtualFileSystem } from "@/lib/file-system";
// streamText: Vercel AI SDK utility that calls an LLM and returns a streaming response.
// appendResponseMessages: merges the AI's reply into the existing message history.
import { streamText, appendResponseMessages } from "ai";
import { buildStrReplaceTool } from "@/lib/tools/str-replace";
import { buildFileManagerTool } from "@/lib/tools/file-manager";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getLanguageModel } from "@/lib/provider";
import { generationPrompt } from "@/lib/prompts/generation";

// Next.js calls this function when a POST request hits /api/chat.
// It receives the full conversation history, the current file system state,
// and an optional project ID for saving progress.
export async function POST(req: Request) {
  // Destructure the JSON body sent by the client (ChatContext via useChat hook).
  // - messages: full conversation history (user + assistant turns)
  // - files: serialized virtual file system so Claude knows what files already exist
  // - projectId: if set, we save the result to the database after generation
  const {
    messages,
    files,
    projectId,
  }: { messages: any[]; files: Record<string, FileNode>; projectId?: string } =
    await req.json();

  // Inject the system prompt at the very beginning of the messages array.
  // unshift() adds to the front — Claude needs the system message first.
  // cacheControl: "ephemeral" tells Anthropic's API to cache this prompt server-side
  // so we don't pay token costs re-sending the same system instructions every turn.
  messages.unshift({
    role: "system",
    content: generationPrompt,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  });

  // Reconstruct the VirtualFileSystem from the serialized snapshot the client sent.
  // This gives Claude's tools a live file system object to read/write during generation.
  // We do this on the server so tool calls (create file, replace text) happen in memory
  // on the server side and the result can be saved to the DB after streaming finishes.
  const fileSystem = new VirtualFileSystem();
  fileSystem.deserializeFromNodes(files);

  // Choose the real Claude model or the mock provider depending on whether
  // ANTHROPIC_API_KEY is present. See src/lib/provider.ts for details.
  const model = getLanguageModel();

  // The mock provider generates a fixed 4-step sequence, so capping at 4 steps
  // prevents it from looping forever on the same synthetic responses.
  // The real Claude model gets up to 40 steps (tool-call rounds) for complex tasks.
  const isMockProvider = !process.env.ANTHROPIC_API_KEY;

  // streamText orchestrates the multi-turn agentic loop:
  // 1. Sends messages + tools to the LLM
  // 2. If Claude calls a tool, executes it, appends the result, and calls the LLM again
  // 3. Repeats until Claude stops calling tools or maxSteps is reached
  // 4. Streams each token/tool-call chunk back to the client in real time
  const result = streamText({
    model,
    messages,
    maxTokens: 10_000,
    maxSteps: isMockProvider ? 4 : 40,
    onError: (err: any) => {
      console.error(err);
    },
    // The two tools Claude can call during component generation:
    // - str_replace_editor: create files, view files, replace text in a file, insert lines
    // - file_manager: rename or delete files/directories
    // Both tools receive the same fileSystem instance so their changes accumulate.
    tools: {
      str_replace_editor: buildStrReplaceTool(fileSystem),
      file_manager: buildFileManagerTool(fileSystem),
    },
    // onFinish runs once after ALL streaming is complete (all steps done).
    // This is the right place to persist data because at this point every tool call
    // has already been applied to `fileSystem` and all assistant messages exist.
    onFinish: async ({ response }) => {
      // Only save if the request is tied to a named project.
      // Anonymous sessions (no projectId) are ephemeral by design.
      if (projectId) {
        try {
          // Verify the user is still authenticated before writing to the DB.
          // We re-check here (not just at the start) because streaming can take
          // many seconds and session cookies could theoretically expire mid-stream.
          const session = await getSession();
          if (!session) {
            console.error("User not authenticated, cannot save project");
            return;
          }

          // response.messages contains only the NEW messages produced this turn.
          // appendResponseMessages merges them with the original history to produce
          // the full, correctly ordered conversation we store in the DB.
          const responseMessages = response.messages || [];
          const allMessages = appendResponseMessages({
            // Filter out the system message — it's reconstructed on every request,
            // so storing it would just waste space in the DB.
            messages: [...messages.filter((m) => m.role !== "system")],
            responseMessages,
          });

          // Persist the updated conversation and file system to the database.
          // We store both as JSON strings in TEXT columns — simple and flexible.
          // The `where` clause also checks userId so users can't overwrite each other's projects.
          await prisma.project.update({
            where: {
              id: projectId,
              userId: session.userId,
            },
            data: {
              messages: JSON.stringify(allMessages),
              data: JSON.stringify(fileSystem.serialize()),
            },
          });
        } catch (error) {
          console.error("Failed to save project data:", error);
        }
      }
    },
  });

  // Convert the streaming result into a standard HTTP streaming response.
  // The Vercel AI SDK uses a custom wire format ("data stream") that the
  // useChat hook on the client knows how to parse — including tool call chunks.
  return result.toDataStreamResponse();
}

// Tell Next.js this route can run for up to 120 seconds before timing out.
// AI generation with many tool-call steps can take significantly longer than
// the default 10-second limit, so we increase it here.
export const maxDuration = 120;
