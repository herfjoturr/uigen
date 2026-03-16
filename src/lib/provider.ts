// ─────────────────────────────────────────────────────────────────────────────
// LLM Provider
// ─────────────────────────────────────────────────────────────────────────────
// This module abstracts away which language model is actually used.
// The rest of the app (the API route) calls getLanguageModel() and gets back
// something that looks the same regardless of whether it's real Claude or a mock.
//
// Why a mock? So developers without an Anthropic API key can still run and
// explore the app. The mock produces a realistic multi-step "tool call" sequence
// that exercises the same code paths as real Claude, just with hardcoded output.
// ─────────────────────────────────────────────────────────────────────────────

// anthropic() returns a real Anthropic Claude model compatible with Vercel AI SDK.
import { anthropic } from "@ai-sdk/anthropic";
// LanguageModelV1 is the interface both the real model and MockLanguageModel implement.
// This is the "contract" — as long as both classes satisfy it, the API route
// doesn't need to know which one it's talking to (Liskov Substitution Principle).
import {
  LanguageModelV1,
  LanguageModelV1StreamPart,
  LanguageModelV1Message,
} from "@ai-sdk/provider";

// The real Claude model to use when an API key is present.
// claude-haiku-4-5 is fast and cheap — good for a code-generation tool.
const MODEL = "claude-haiku-4-5";

// ─────────────────────────────────────────────────────────────────────────────
// MockLanguageModel
// ─────────────────────────────────────────────────────────────────────────────
// A fake LLM that implements the same LanguageModelV1 interface as the real one.
// It simulates a 4-step agentic sequence: create App.jsx → create component →
// enhance component → print summary. This mirrors what real Claude would do.
export class MockLanguageModel implements LanguageModelV1 {
  // Required by the LanguageModelV1 interface — identifies the API version.
  readonly specificationVersion = "v1" as const;
  readonly provider = "mock";
  readonly modelId: string;
  // "tool" means the model prefers to output structured tool calls rather than
  // raw JSON text. Matches how real Claude behaves with tools enabled.
  readonly defaultObjectGenerationMode = "tool" as const;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  // Small helper to slow down streaming output so it feels like a real LLM
  // rather than an instant dump of text. Makes the UX easier to follow.
  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Scans the message history backwards to find the most recent user message.
  // The mock uses this to decide which component type to generate (counter,
  // form, or card) based on keywords in the user's request.
  private extractUserPrompt(messages: LanguageModelV1Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user") {
        const content = message.content;
        if (Array.isArray(content)) {
          // Vercel AI SDK wraps message content in typed "parts" for multimodal support.
          // We only care about text parts here.
          const textParts = content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text);
          return textParts.join(" ");
        } else if (typeof content === "string") {
          return content;
        }
      }
    }
    return "";
  }

  // Retrieves the most recent "tool" message from history.
  // In the agentic loop, after each tool call the result is appended as a "tool" message.
  // The mock uses the count of these messages to know which step of its script to run.
  private getLastToolResult(messages: LanguageModelV1Message[]): any {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "tool") {
        const content = messages[i].content;
        if (Array.isArray(content) && content.length > 0) {
          return content[0];
        }
      }
    }
    return null;
  }

  // ── Mock Streaming Logic ──────────────────────────────────────────────────
  // This async generator yields a sequence of LanguageModelV1StreamPart values.
  // Each chunk is either a text delta (a few characters of prose), a tool call
  // (structured JSON telling the system to run a file operation), or a finish signal.
  //
  // The Vercel AI SDK's streamText() calls doStream() on the model and feeds these
  // chunks into its state machine, which executes the tool calls and loops back.
  private async *generateMockStream(
    messages: LanguageModelV1Message[],
    userPrompt: string
  ): AsyncGenerator<LanguageModelV1StreamPart> {
    // Count how many tool-result messages exist to determine which step we're on.
    // Step 0: no tools called yet (first LLM turn)
    // Step 1: one tool was called and its result was appended
    // Step 2: two tools called, etc.
    const toolMessageCount = messages.filter((m) => m.role === "tool").length;

    // Choose which demo component to generate based on keywords in the prompt.
    const promptLower = userPrompt.toLowerCase();
    let componentType = "counter";
    let componentName = "Counter";

    if (promptLower.includes("form")) {
      componentType = "form";
      componentName = "ContactForm";
    } else if (promptLower.includes("card")) {
      componentType = "card";
      componentName = "Card";
    }

    // ── Step 1 (toolMessageCount === 1): Create the component file ──
    // At this point App.jsx was just created (step 0) and the tool result came back.
    // Now we create the actual component file.
    if (toolMessageCount === 1) {
      const text = `I'll create a ${componentName} component for you.`;
      // Stream the prose one character at a time to simulate typing.
      for (const char of text) {
        yield { type: "text-delta", textDelta: char };
        await this.delay(25);
      }

      // Emit a tool call chunk. The SDK will execute str_replace_editor → create
      // which writes the component file into the VirtualFileSystem.
      yield {
        type: "tool-call",
        toolCallType: "function",
        toolCallId: `call_1`,
        toolName: "str_replace_editor",
        args: JSON.stringify({
          command: "create",
          path: `/components/${componentName}.jsx`,
          file_text: this.getComponentCode(componentType),
        }),
      };

      // "tool-calls" finish reason tells the SDK to execute the tools and loop back.
      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: { promptTokens: 50, completionTokens: 30 },
      };
      return;
    }

    // ── Step 2 (toolMessageCount === 2): Enhance the component ──
    // Demonstrates that Claude can also edit existing files, not just create them.
    if (toolMessageCount === 2) {
      const text = `Now let me enhance the component with better styling.`;
      for (const char of text) {
        yield { type: "text-delta", textDelta: char };
        await this.delay(25);
      }

      // str_replace replaces a specific code snippet inside the existing file.
      // This shows the "surgical edit" pattern rather than rewriting the whole file.
      yield {
        type: "tool-call",
        toolCallType: "function",
        toolCallId: `call_2`,
        toolName: "str_replace_editor",
        args: JSON.stringify({
          command: "str_replace",
          path: `/components/${componentName}.jsx`,
          old_str: this.getOldStringForReplace(componentType),
          new_str: this.getNewStringForReplace(componentType),
        }),
      };

      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: { promptTokens: 50, completionTokens: 30 },
      };
      return;
    }

    // ── Step 0 (toolMessageCount === 0): First LLM turn — create App.jsx ──
    // NOTE: This case is checked AFTER step 1 and 2 because those are the more
    // common branches during a multi-step flow. Step 0 is the entry point.
    if (toolMessageCount === 0) {
      const text = `This is a static response. You can place an Anthropic API key in the .env file to use the Anthropic API for component generation. Let me create an App.jsx file to display the component.`;
      for (const char of text) {
        yield { type: "text-delta", textDelta: char };
        await this.delay(15);
      }

      // Create the App.jsx entry point first. The preview iframe always looks
      // for /App.jsx as the root component to render.
      yield {
        type: "tool-call",
        toolCallType: "function",
        toolCallId: `call_3`,
        toolName: "str_replace_editor",
        args: JSON.stringify({
          command: "create",
          path: "/App.jsx",
          file_text: this.getAppCode(componentName),
        }),
      };

      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: { promptTokens: 50, completionTokens: 30 },
      };
      return;
    }

    // ── Step 3+ (toolMessageCount >= 3): Final summary ──
    // No more tool calls — Claude wraps up with a text summary.
    // "stop" finish reason tells the SDK the conversation turn is complete.
    if (toolMessageCount >= 3) {
      const text = `Perfect! I've created:

1. **${componentName}.jsx** - A fully-featured ${componentType} component
2. **App.jsx** - The main app file that displays the component

The component is now ready to use. You can see the preview on the right side of the screen.`;

      for (const char of text) {
        yield { type: "text-delta", textDelta: char };
        await this.delay(30);
      }

      yield {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 50, completionTokens: 50 },
      };
      return;
    }
  }

  // ── Hardcoded Component Templates ─────────────────────────────────────────
  // Each template is valid JSX + Tailwind CSS — the same stack the real Claude
  // is instructed to use (see src/lib/prompts/generation.tsx).

  private getComponentCode(componentType: string): string {
    switch (componentType) {
      case "form":
        return `import React, { useState } from 'react';

const ContactForm = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    message: ''
  });

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    console.log('Form submitted:', formData);
    // Handle form submission here
  };

  return (
    <div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md">
      <h2 className="text-2xl font-bold mb-6">Contact Us</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Name
          </label>
          <input
            type="text"
            id="name"
            name="name"
            value={formData.name}
            onChange={handleChange}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email
          </label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">
            Message
          </label>
          <textarea
            id="message"
            name="message"
            value={formData.message}
            onChange={handleChange}
            required
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <button
          type="submit"
          className="w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 transition-colors"
        >
          Send Message
        </button>
      </form>
    </div>
  );
};

export default ContactForm;`;

      case "card":
        return `import React from 'react';

const Card = ({
  title = "Welcome to Our Service",
  description = "Discover amazing features and capabilities that will transform your experience.",
  imageUrl,
  actions
}) => {
  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden">
      {imageUrl && (
        <img
          src={imageUrl}
          alt={title}
          className="w-full h-48 object-cover"
        />
      )}
      <div className="p-6">
        <h3 className="text-xl font-semibold mb-2">{title}</h3>
        <p className="text-gray-600 mb-4">{description}</p>
        {actions && (
          <div className="mt-4">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
};

export default Card;`;

      default:
        return `import { useState } from 'react';

const Counter = () => {
  const [count, setCount] = useState(0);

  const increment = () => {
    setCount(count + 1);
  };

  const decrement = () => {
    setCount(count - 1);
  };

  const reset = () => {
    setCount(0);
  };

  return (
    <div className="flex flex-col items-center p-6 bg-white rounded-lg shadow-md">
      <h2 className="text-2xl font-bold mb-4">Counter</h2>
      <div className="text-4xl font-bold mb-6">{count}</div>
      <div className="flex gap-4">
        <button
          onClick={decrement}
          className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
        >
          Decrease
        </button>
        <button
          onClick={reset}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
        >
          Reset
        </button>
        <button
          onClick={increment}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
        >
          Increase
        </button>
      </div>
    </div>
  );
};

export default Counter;`;
    }
  }

  // Returns a code snippet that exists in the component — used as the target for str_replace.
  // The snippet must be unique enough that replaceInFile finds exactly the right spot.
  private getOldStringForReplace(componentType: string): string {
    switch (componentType) {
      case "form":
        return "    console.log('Form submitted:', formData);";
      case "card":
        return '      <div className="p-6">';
      default:
        return "  const increment = () => setCount(count + 1);";
    }
  }

  // The replacement string. The mock keeps it simple — just adds one small improvement
  // to show that the str_replace editing flow works end-to-end.
  private getNewStringForReplace(componentType: string): string {
    switch (componentType) {
      case "form":
        return "    console.log('Form submitted:', formData);\n    alert('Thank you! We\\'ll get back to you soon.');";
      case "card":
        return '      <div className="p-6 hover:bg-gray-50 transition-colors">';
      default:
        return "  const increment = () => setCount(prev => prev + 1);";
    }
  }

  // Generates the App.jsx that imports and renders the generated component.
  // App.jsx is always the entry point the preview iframe looks for first.
  private getAppCode(componentName: string): string {
    if (componentName === "Card") {
      // Card needs props passed to it, so we include a more complete example.
      return `import Card from '@/components/Card';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <Card
          title="Amazing Product"
          description="This is a fantastic product that will change your life. Experience the difference today!"
          actions={
            <button className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition-colors">
              Learn More
            </button>
          }
        />
      </div>
    </div>
  );
}`;
    }

    // Generic template: just render the component inside a centred, grey-background page.
    return `import ${componentName} from '@/components/${componentName}';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <${componentName} />
      </div>
    </div>
  );
}`;
  }

  // ── LanguageModelV1 Interface Implementation ───────────────────────────────
  // The Vercel AI SDK can call either doGenerate (batch) or doStream (streaming).
  // We implement both so the mock works in any context.

  // doGenerate collects all stream parts and returns them as a single object.
  // Used internally when the SDK needs a non-streaming result (e.g., for embeddings).
  async doGenerate(
    options: Parameters<LanguageModelV1["doGenerate"]>[0]
  ): Promise<Awaited<ReturnType<LanguageModelV1["doGenerate"]>>> {
    const userPrompt = this.extractUserPrompt(options.prompt);

    // Run the async generator to completion and collect every chunk.
    const parts: LanguageModelV1StreamPart[] = [];
    for await (const part of this.generateMockStream(
      options.prompt,
      userPrompt
    )) {
      parts.push(part);
    }

    // Reconstruct the text by joining all text-delta chunks.
    const textParts = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as any).textDelta)
      .join("");

    // Reconstruct tool calls from tool-call chunks.
    const toolCalls = parts
      .filter((p) => p.type === "tool-call")
      .map((p) => ({
        toolCallType: "function" as const,
        toolCallId: (p as any).toolCallId,
        toolName: (p as any).toolName,
        args: (p as any).args,
      }));

    const finishPart = parts.find((p) => p.type === "finish") as any;
    const finishReason = finishPart?.finishReason || "stop";

    return {
      text: textParts,
      toolCalls,
      finishReason: finishReason as any,
      usage: { promptTokens: 100, completionTokens: 200 },
      warnings: [],
      rawCall: {
        rawPrompt: options.prompt,
        rawSettings: {
          maxTokens: options.maxTokens,
          temperature: options.temperature,
        },
      },
    };
  }

  // doStream wraps generateMockStream in a ReadableStream so the SDK can consume
  // chunks incrementally — exactly as it would with a real network response.
  async doStream(
    options: Parameters<LanguageModelV1["doStream"]>[0]
  ): Promise<Awaited<ReturnType<LanguageModelV1["doStream"]>>> {
    const userPrompt = this.extractUserPrompt(options.prompt);
    // Capture `this` because ReadableStream's `start` callback loses the class context.
    const self = this;

    // ReadableStream is the Web Streams API equivalent of Node's Readable.
    // The controller lets us push chunks (enqueue) and signal the end (close).
    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        try {
          const generator = self.generateMockStream(options.prompt, userPrompt);
          for await (const chunk of generator) {
            controller.enqueue(chunk);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return {
      stream,
      warnings: [],
      rawCall: {
        rawPrompt: options.prompt,
        rawSettings: {},
      },
      rawResponse: { headers: {} },
    };
  }
}

// ── Factory Function ──────────────────────────────────────────────────────────
// The API route calls this once per request to get the appropriate model.
// Centralising the decision here means the rest of the code never needs
// to check for the API key — it just uses whatever getLanguageModel() returns.
export function getLanguageModel() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    console.log("No ANTHROPIC_API_KEY found, using mock provider");
    // Return a mock that implements the same interface so callers don't care.
    return new MockLanguageModel("mock-claude-sonnet-4-0");
  }

  // Return a real Anthropic model. anthropic() is from @ai-sdk/anthropic and
  // automatically reads ANTHROPIC_API_KEY from the environment.
  return anthropic(MODEL);
}
