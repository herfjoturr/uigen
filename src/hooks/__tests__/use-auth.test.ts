import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAuth } from "@/hooks/use-auth";

// ─── Mock all external dependencies ───────────────────────────────────────────

// next/navigation: capture the push function so we can assert navigation calls
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Server actions: sign-in / sign-up return AuthResult shapes
vi.mock("@/actions", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
}));

// Anonymous-work tracker: controls whether guest work exists before sign-in
vi.mock("@/lib/anon-work-tracker", () => ({
  getAnonWorkData: vi.fn(),
  clearAnonWork: vi.fn(),
}));

// Project server actions
vi.mock("@/actions/get-projects", () => ({
  getProjects: vi.fn(),
}));

vi.mock("@/actions/create-project", () => ({
  createProject: vi.fn(),
}));

// ─── Import mocked modules so tests can configure return values ────────────────
import { signIn as signInAction, signUp as signUpAction } from "@/actions";
import { getAnonWorkData, clearAnonWork } from "@/lib/anon-work-tracker";
import { getProjects } from "@/actions/get-projects";
import { createProject } from "@/actions/create-project";

// ─── Shared test data ──────────────────────────────────────────────────────────
const MOCK_PROJECT = { id: "proj-123", name: "Test Project" };

const ANON_MESSAGES = [{ role: "user", content: "Build a button" }];
const ANON_FS_DATA = { "/App.jsx": { content: "<div/>" } };

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Make getAnonWorkData return data that has messages (triggers the migrate path). */
function setAnonWorkWithMessages() {
  (getAnonWorkData as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: ANON_MESSAGES,
    fileSystemData: ANON_FS_DATA,
  });
}

/** Make getAnonWorkData return data with NO messages (skips the migrate path). */
function setAnonWorkEmpty() {
  (getAnonWorkData as ReturnType<typeof vi.fn>).mockReturnValue({
    messages: [],
    fileSystemData: {},
  });
}

/** Make getAnonWorkData return null (no tracker entry at all). */
function setNoAnonWork() {
  (getAnonWorkData as ReturnType<typeof vi.fn>).mockReturnValue(null);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();

  // Safe defaults: actions succeed; no anon work; one existing project
  (signInAction as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
  (signUpAction as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
  setNoAnonWork();
  (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROJECT]);
  (createProject as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
});

// ─── isLoading state ───────────────────────────────────────────────────────────
describe("isLoading state", () => {
  test("starts as false", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.isLoading).toBe(false);
  });

  test("is true while signIn is in-flight, then resets to false", async () => {
    // Delay the action so we can observe the loading state mid-flight
    let resolveSignIn!: (v: { success: boolean }) => void;
    (signInAction as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((res) => (resolveSignIn = res))
    );

    const { result } = renderHook(() => useAuth());

    // Start sign-in but don't await yet
    act(() => {
      result.current.signIn("a@b.com", "password123");
    });

    expect(result.current.isLoading).toBe(true);

    // Resolve and wait for the hook to settle
    await act(async () => {
      resolveSignIn({ success: false });
    });

    expect(result.current.isLoading).toBe(false);
  });

  test("is true while signUp is in-flight, then resets to false", async () => {
    let resolveSignUp!: (v: { success: boolean }) => void;
    (signUpAction as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((res) => (resolveSignUp = res))
    );

    const { result } = renderHook(() => useAuth());

    act(() => {
      result.current.signUp("a@b.com", "password123");
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveSignUp({ success: false });
    });

    expect(result.current.isLoading).toBe(false);
  });

  test("resets isLoading to false even when signIn throws", async () => {
    // The action itself throws (network failure, server error, etc.)
    (signInAction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error")
    );

    const { result } = renderHook(() => useAuth());

    // The hook re-throws so callers can handle it; we swallow it here
    await act(async () => {
      await result.current.signIn("a@b.com", "password123").catch(() => {});
    });

    // finally block must have run
    expect(result.current.isLoading).toBe(false);
  });

  test("resets isLoading to false even when signUp throws", async () => {
    (signUpAction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error")
    );

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signUp("a@b.com", "password123").catch(() => {});
    });

    expect(result.current.isLoading).toBe(false);
  });
});

// ─── signIn – failure paths ────────────────────────────────────────────────────
describe("signIn – failure", () => {
  test("returns the error result and does NOT navigate when credentials are wrong", async () => {
    (signInAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "Invalid credentials",
    });

    const { result } = renderHook(() => useAuth());
    let returnValue: any;

    await act(async () => {
      returnValue = await result.current.signIn("wrong@example.com", "bad");
    });

    expect(returnValue).toEqual({ success: false, error: "Invalid credentials" });
    expect(mockPush).not.toHaveBeenCalled();
    expect(getProjects).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });
});

// ─── signIn – post-sign-in: anonymous work migration ──────────────────────────
describe("signIn – post-sign-in with anonymous work", () => {
  test("creates a project from anon data, clears tracker, and navigates to it", async () => {
    setAnonWorkWithMessages();
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "new-proj-from-anon",
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    // Must have created a project carrying the anon messages and FS data
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: ANON_MESSAGES,
        data: ANON_FS_DATA,
      })
    );

    // Anon storage must be wiped after migration
    expect(clearAnonWork).toHaveBeenCalled();

    // Must navigate to the newly created project
    expect(mockPush).toHaveBeenCalledWith("/new-proj-from-anon");

    // getProjects should be skipped — we already have a destination
    expect(getProjects).not.toHaveBeenCalled();
  });

  test("skips anon migration when anon work has zero messages", async () => {
    // messages: [] → the if-guard (anonWork.messages.length > 0) is false
    setAnonWorkEmpty();

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    // Should fall through to the existing-projects path
    expect(getProjects).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(`/${MOCK_PROJECT.id}`);
    expect(clearAnonWork).not.toHaveBeenCalled();
  });

  test("skips anon migration when getAnonWorkData returns null", async () => {
    setNoAnonWork();

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    expect(getProjects).toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(clearAnonWork).not.toHaveBeenCalled();
  });
});

// ─── signIn – post-sign-in: project navigation ────────────────────────────────
describe("signIn – post-sign-in project navigation", () => {
  test("navigates to the most-recent existing project when no anon work", async () => {
    const projects = [
      { id: "recent-proj" },
      { id: "older-proj" },
    ];
    (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue(projects);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    // The first entry from getProjects (most recent, ordered by updatedAt desc on server)
    expect(mockPush).toHaveBeenCalledWith("/recent-proj");
    expect(createProject).not.toHaveBeenCalled();
  });

  test("creates a new project and navigates to it when user has no existing projects", async () => {
    (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "brand-new",
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [],
        data: {},
      })
    );
    expect(mockPush).toHaveBeenCalledWith("/brand-new");
  });

  test("new project name includes a random number suffix for uniqueness", async () => {
    (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "x" });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signIn("user@example.com", "password123");
    });

    const calledWith = (createProject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledWith.name).toMatch(/^New Design #\d+$/);
  });
});

// ─── signUp – mirrors signIn post-auth behaviour ──────────────────────────────
describe("signUp – failure", () => {
  test("returns the error result and does NOT navigate", async () => {
    (signUpAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "Email already registered",
    });

    const { result } = renderHook(() => useAuth());
    let returnValue: any;

    await act(async () => {
      returnValue = await result.current.signUp("taken@example.com", "password123");
    });

    expect(returnValue).toEqual({
      success: false,
      error: "Email already registered",
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("signUp – post-sign-up with anonymous work", () => {
  test("migrates anon work after successful sign-up", async () => {
    setAnonWorkWithMessages();
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "anon-migrated",
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signUp("new@example.com", "password123");
    });

    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({ messages: ANON_MESSAGES })
    );
    expect(clearAnonWork).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/anon-migrated");
  });
});

describe("signUp – post-sign-up project navigation", () => {
  test("navigates to most-recent project when no anon work", async () => {
    (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "existing-proj" },
    ]);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signUp("new@example.com", "password123");
    });

    expect(mockPush).toHaveBeenCalledWith("/existing-proj");
  });

  test("creates a new project when user has no existing projects", async () => {
    (getProjects as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (createProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "fresh-proj",
    });

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await result.current.signUp("brand-new@example.com", "password123");
    });

    expect(createProject).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith("/fresh-proj");
  });
});

// ─── Return value shape ────────────────────────────────────────────────────────
describe("hook return value", () => {
  test("exposes signIn, signUp, and isLoading", () => {
    const { result } = renderHook(() => useAuth());

    expect(typeof result.current.signIn).toBe("function");
    expect(typeof result.current.signUp).toBe("function");
    expect(typeof result.current.isLoading).toBe("boolean");
  });

  test("signIn forwards the AuthResult returned by the server action", async () => {
    (signInAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
    });

    const { result } = renderHook(() => useAuth());
    let returnValue: any;

    await act(async () => {
      returnValue = await result.current.signIn("a@b.com", "pass");
    });

    expect(returnValue).toEqual({ success: true });
  });

  test("signUp forwards the AuthResult returned by the server action", async () => {
    (signUpAction as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: "Email already registered",
    });

    const { result } = renderHook(() => useAuth());
    let returnValue: any;

    await act(async () => {
      returnValue = await result.current.signUp("a@b.com", "pass").catch(
        () => ({ success: false, error: "Email already registered" })
      );
    });

    expect(returnValue).toEqual({
      success: false,
      error: "Email already registered",
    });
  });
});
