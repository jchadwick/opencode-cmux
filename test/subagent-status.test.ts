import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/index"

type SessionInfo = {
  id: string
  title: string
  parentID?: string
}

type LookupResult = { data?: SessionInfo }
type Lookup = (sessionID: string) => Promise<LookupResult>

type FakeResult = {
  exitCode: number
  stdout: { toString(): string }
  text(): string
}

type FakeCommand = {
  quiet(): FakeCommand
  nothrow(): Promise<FakeResult>
}

type FakeShell = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => FakeCommand

type DeferredShellCommand = {
  command: string
  resolve(): void
  reject(): void
}

type ShellController = {
  readonly pending: DeferredShellCommand[]
  readonly inFlight: number
  readonly maxInFlight: number
  releaseNext(): void
  rejectNext(): void
}

type Harness = {
  commands: string[]
  shell: ShellController
  emit(event: unknown): Promise<void>
  setSession(session: SessionInfo): void
}

const originalEnvironment = () => ({ ...process.env })

function restoreEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) delete process.env[key]
  }

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function formatShellValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatShellValue).join(" ")
  if (value === undefined) return ""
  return String(value)
}

function makeShell(
  commands: string[],
  options: { deferDedicated?: boolean } = {},
): { shell: FakeShell; controller: ShellController } {
  const pending: DeferredShellCommand[] = []
  let inFlight = 0
  let maxInFlight = 0

  const controller: ShellController = {
    pending,
    get inFlight() {
      return inFlight
    },
    get maxInFlight() {
      return maxInFlight
    },
    releaseNext() {
      const operation = pending.shift()
      if (!operation) throw new Error("no deferred shell command to release")
      operation.resolve()
    },
    rejectNext() {
      const operation = pending.shift()
      if (!operation) throw new Error("no deferred shell command to reject")
      operation.reject()
    },
  }

  function resultFor(command: string): FakeResult {
    const output = command.includes("new-split")
      ? "OK surface:subagent workspace:test"
      : ""
    return {
      exitCode: 0,
      stdout: { toString: () => output },
      text: () => output,
    }
  }

  function runCommand(command: string): Promise<FakeResult> {
    if (!options.deferDedicated || !command.includes("opencode-subagents")) {
      return Promise.resolve(resultFor(command))
    }

    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        inFlight--
        finish()
      }
      pending.push({
        command,
        resolve: () => settle(() => resolve(resultFor(command))),
        reject: () => settle(() => reject(new Error("deferred cmux failure"))),
      })
    })
  }

  const shell = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce(
      (result, string, index) =>
        result + string + (index < values.length ? formatShellValue(values[index]) : ""),
      "",
    )
    commands.push(command)

    const commandPromise: FakeCommand = {
      quiet: () => commandPromise,
      nothrow: () => runCommand(command),
    }
    return commandPromise
  }) as FakeShell

  return { shell, controller }
}

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { splits?: boolean; lookup?: Lookup; deferDedicated?: boolean } = {},
): Promise<void> {
  const environment = originalEnvironment()
  const configHome = mkdtempSync(join(tmpdir(), "opencode-cmux-test-"))
  const configDirectory = join(configHome, "opencode")
  mkdirSync(configDirectory)

  try {
    // Keep every test inside cmux without depending on the host's socket.
    process.env.CMUX_WORKSPACE_ID = "workspace:test"
    process.env.XDG_CONFIG_HOME = configHome
    process.env.CMUX_SURFACE_ID = "surface:root"
    if (options.splits) {
      process.env.OPENCODE_SERVER_URL = "http://localhost:4096"
      writeFileSync(join(configDirectory, "opencode-cmux.json"), '{"splits":true}')
    } else {
      delete process.env.OPENCODE_SERVER_URL
    }

    const commands: string[] = []
    const sessions = new Map<string, SessionInfo>()
    const lookup =
      options.lookup ??
      (async (sessionID: string): Promise<LookupResult> => ({
        data: sessions.get(sessionID),
      }))
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => lookup(path.id),
      },
    }
    const { shell, controller } = makeShell(commands, options)
    const hooks = await plugin({
      client,
      project: {},
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register() {} },
      serverUrl: new URL("http://localhost:4096"),
      $: shell,
    } as Parameters<typeof plugin>[0])

    if (!hooks.event) throw new Error("plugin did not register an event hook")

    await run({
      commands,
      shell: controller,
      emit: (event) => hooks.event!({ event } as never),
      setSession: (session) => sessions.set(session.id, session),
    })
  } finally {
    rmSync(configHome, { recursive: true, force: true })
    restoreEnvironment(environment)
  }
}

function session(id: string, parentID?: string): SessionInfo {
  return { id, title: id, ...(parentID ? { parentID } : {}) }
}

function taskPart(
  sessionID: string,
  messageID: string,
  partID: string,
  status: "pending" | "running" | "completed" | "error",
) {
  const state =
    status === "pending"
      ? { status, input: {}, raw: "" }
      : status === "running"
        ? { status, input: {}, time: { start: 1 } }
        : status === "completed"
          ? { status, input: {}, output: "done", title: "Task", metadata: {}, time: { start: 1, end: 2 } }
          : { status, input: {}, error: "failed", time: { start: 1, end: 2 } }

  return {
    id: partID,
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${partID}`,
    tool: "task",
    state,
  }
}

function taskUpdate(
  sessionID: string,
  messageID: string,
  partID: string,
  status: "pending" | "running" | "completed" | "error",
) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: taskPart(sessionID, messageID, partID, status),
      time: 1,
    },
  }
}

function partRemoved(sessionID: string, messageID: string, partID: string) {
  return {
    type: "message.part.removed",
    properties: { sessionID, messageID, partID },
  }
}

function messageRemoved(sessionID: string, messageID: string) {
  return {
    type: "message.removed",
    properties: { sessionID, messageID },
  }
}

function sessionCreated(info: SessionInfo) {
  return {
    type: "session.created",
    properties: { sessionID: info.id, info },
  }
}

function sessionStatus(
  sessionID: string,
  status: "busy" | "idle" | "retry",
) {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status:
        status === "retry"
          ? { type: status, attempt: 1, message: "retrying", next: 1 }
          : { type: status },
    },
  }
}

function sessionIdle(sessionID: string) {
  return {
    type: "session.idle",
    properties: { sessionID },
  }
}

function sessionError(sessionID: string) {
  return {
    type: "session.error",
    properties: { sessionID, error: { name: "UnknownError", message: "failed" } },
  }
}

function sessionDeleted(info: SessionInfo) {
  return {
    type: "session.deleted",
    properties: { sessionID: info.id, info },
  }
}

function tail(command: string, operation: string): string {
  const index = command.indexOf(operation)
  return index === -1 ? "" : command.slice(index)
}

function dedicatedStatusCommands(commands: string[]): string[] {
  return commands
    .map((command) => {
      if (command.includes("set-status opencode-subagents")) {
        const status = tail(command, "set-status")
        const options = status.search(/\s--(?:icon|color)\s/)
        return options === -1 ? status : status.slice(0, options)
      }
      if (command.includes("clear-status opencode-subagents"))
        return tail(command, "clear-status")
      return ""
    })
    .filter(Boolean)
}

function genericStatusCommands(commands: string[]): string[] {
  return commands
    .map((command) => {
      if (command.includes("set-status opencode ")) return "set-status opencode working"
      if (command.includes("clear-status opencode")) return tail(command, "clear-status")
      return ""
    })
    .filter(Boolean)
}

async function settleStatusCommands(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

test("tracks running task parts, ignores pending, and is idempotent", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "message-1", "task-1", "pending"))
    expect(dedicatedStatusCommands(harness.commands)).toEqual([])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
  })
})

test("keeps parallel task work active and scopes part/message removal", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "message-a", "task-a", "running"))
    await harness.emit(taskUpdate("root", "message-b", "task-b", "running"))
    await harness.emit(partRemoved("root", "message-a", "task-a"))
    await harness.emit(partRemoved("root", "message-a", "task-a"))

    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(messageRemoved("root", "message-a"))
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(messageRemoved("root", "message-b"))
    await harness.emit(messageRemoved("root", "message-b"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
  })
})

test("completed, errored, and removed task parts clean the dedicated status", async () => {
  const cleanups = [
    {
      name: "error",
      event: () => taskUpdate("root", "message-1", "task-1", "error"),
    },
    {
      name: "part removal",
      event: () => partRemoved("root", "message-1", "task-1"),
    },
    {
      name: "message removal",
      event: () => messageRemoved("root", "message-1"),
    },
  ]

  for (const cleanup of cleanups) {
    await withHarness(async (harness) => {
      await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
      await harness.emit(cleanup.event())
      await settleStatusCommands()

      expect(dedicatedStatusCommands(harness.commands), cleanup.name).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
      ])
    })
  }
})

test("keeps the dedicated status until both task and child sources are idle", async () => {
  await withHarness(async (harness) => {
    const child = session("child-1", "root")
    harness.setSession(child)

    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(sessionStatus(child.id, "busy"))
    await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
    await settleStatusCommands()

    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(sessionStatus(child.id, "idle"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
  })

  await withHarness(async (harness) => {
    const child = session("child-2", "root")
    harness.setSession(child)

    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(sessionStatus(child.id, "retry"))
    await harness.emit(sessionStatus(child.id, "idle"))
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "error"))
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
  })
})

test("does not activate on child creation and preserves child completion logging", async () => {
  await withHarness(async (harness) => {
    const child = session("child-3", "root")
    harness.setSession(child)

    await harness.emit(sessionCreated(child))
    expect(dedicatedStatusCommands(harness.commands)).toEqual([])

    await harness.emit(sessionStatus(child.id, "busy"))
    await harness.emit(sessionStatus(child.id, "retry"))
    await harness.emit(sessionStatus(child.id, "busy"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])
    expect(genericStatusCommands(harness.commands)).toContain(
      "set-status opencode working",
    )

    await harness.emit(sessionStatus(child.id, "idle"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
    expect(harness.commands.some((command) => command.includes("Subagent finished: child-3"))).toBe(
      true,
    )
  })
})

test("child error and deletion deactivate their own background activity", async () => {
  for (const terminal of ["error", "deleted"] as const) {
    await withHarness(async (harness) => {
      const child = session(`child-${terminal}`, "root")
      harness.setSession(child)
      await harness.emit(sessionStatus(child.id, "busy"))

      if (terminal === "error") await harness.emit(sessionError(child.id))
      else await harness.emit(sessionDeleted(child))
      await settleStatusCommands()

      expect(dedicatedStatusCommands(harness.commands), terminal).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
      ])
    })
  }
})

test("task activity is independent of the generic primary-session status", async () => {
  await withHarness(async (harness) => {
    harness.setSession(session("root"))

    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(sessionStatus("root", "busy"))
    await harness.emit(sessionStatus("root", "idle"))

    expect(genericStatusCommands(harness.commands)).toEqual([
      "set-status opencode working",
      "clear-status opencode",
    ])
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
    ])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
    await settleStatusCommands()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      "set-status opencode-subagents agent working",
      "clear-status opencode-subagents",
    ])
  })
})

test("keeps split creation and child completion behavior alongside the new status", async () => {
  await withHarness(
    async (harness) => {
      const child = session("child-split", "root")
      harness.setSession(child)

      await harness.emit(sessionCreated(child))
      expect(harness.commands.some((command) => command.includes("new-split"))).toBe(true)
      expect(dedicatedStatusCommands(harness.commands)).toEqual([])

      await harness.emit(sessionStatus(child.id, "busy"))
      await harness.emit(sessionStatus(child.id, "idle"))
      expect(harness.commands.some((command) => command.includes("Subagent finished: child-split"))).toBe(
        true,
      )
      expect(harness.commands.some((command) => command.includes("close-surface"))).toBe(true)
    },
    { splits: true },
  )
})

test("a late session lookup cannot resurrect a child after it went idle", async () => {
  let lookupCount = 0
  let resolveLookup!: (result: LookupResult) => void
  const lookup = (sessionID: string): Promise<LookupResult> => {
    if (sessionID !== "unknown-child" || lookupCount++ > 0) {
      return Promise.resolve({})
    }
    return new Promise((resolve) => {
      resolveLookup = resolve
    })
  }

  await withHarness(async (harness) => {
    const busy = harness.emit(sessionStatus("unknown-child", "busy"))
    await Promise.resolve()
    const idle = harness.emit(sessionStatus("unknown-child", "idle"))
    await Promise.resolve()

    if (resolveLookup) resolveLookup({ data: session("unknown-child", "root") })
    await Promise.all([busy, idle])

    expect(
      dedicatedStatusCommands(harness.commands).filter((command) =>
        command.startsWith("set-status"),
      ),
    ).toEqual([])
  }, { lookup })
})

test("serializes rapid dedicated status transitions and recovers after a failed render", async () => {
  await withHarness(
    async (harness) => {
      const transitions = [
        harness.emit(taskUpdate("root", "message-1", "task-1", "running")),
        harness.emit(taskUpdate("root", "message-1", "task-1", "completed")),
        harness.emit(taskUpdate("root", "message-2", "task-2", "running")),
      ]

      // The event reducer is synchronous; rendering is deliberately still
      // blocked behind the first deferred cmux command.
      await Promise.all(transitions)
      await Promise.resolve()
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending).toHaveLength(1)
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
      ])

      harness.shell.releaseNext()
      await settleStatusCommands()
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("clear-status opencode-subagents"),
      ])

      // A rejected clear must not strand the queue: the later set still
      // starts, and remains the final visible state.
      harness.shell.rejectNext()
      await settleStatusCommands()
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("set-status opencode-subagents agent working"),
      ])
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
        "set-status opencode-subagents agent working",
      ])

      harness.shell.releaseNext()
      await settleStatusCommands()
      expect(harness.shell.inFlight).toBe(0)
      expect(harness.shell.pending).toHaveLength(0)
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
        "set-status opencode-subagents agent working",
      ])
    },
    { deferDedicated: true },
  )
})

test("handles session.idle once per child cycle, including concurrent idle events", async () => {
  await withHarness(
    async (harness) => {
      const firstChild = session("child-idle-event-1", "root")
      harness.setSession(firstChild)
      await harness.emit(sessionCreated(firstChild))
      await harness.emit(sessionStatus(firstChild.id, "busy"))
      await settleStatusCommands()
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
      ])

      // The legacy session.idle event is sufficient on its own.
      await harness.emit(sessionIdle(firstChild.id))
      await settleStatusCommands()
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
      ])
      expect(
        harness.commands.filter((command) =>
          command.includes("Subagent finished: child-idle-event-1"),
        ),
      ).toHaveLength(1)
      expect(harness.commands.filter((command) => command.includes("close-surface"))).toHaveLength(1)

      // A second cycle delivers both idle forms concurrently. Only one
      // completion side effect and one status transition may result.
      const secondChild = session("child-idle-event-2", "root")
      harness.setSession(secondChild)
      await harness.emit(sessionCreated(secondChild))
      await harness.emit(sessionStatus(secondChild.id, "busy"))
      await settleStatusCommands()

      const pairedIdle = [
        harness.emit(sessionStatus(secondChild.id, "idle")),
        harness.emit(sessionIdle(secondChild.id)),
      ]
      await Promise.all(pairedIdle)
      await settleStatusCommands()

      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
      ])
      expect(
        harness.commands.filter((command) =>
          command.includes("Subagent finished: child-idle-event-2"),
        ),
      ).toHaveLength(1)
      expect(harness.commands.filter((command) => command.includes("close-surface"))).toHaveLength(2)

      // A later ordinary busy/status-idle cycle still renders and cleans up
      // after the paired idle delivery from the preceding cycle.
      const thirdChild = session("child-idle-event-3", "root")
      harness.setSession(thirdChild)
      await harness.emit(sessionCreated(thirdChild))
      await harness.emit(sessionStatus(thirdChild.id, "busy"))
      await settleStatusCommands()
      await harness.emit(sessionStatus(thirdChild.id, "idle"))
      await settleStatusCommands()

      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
        "set-status opencode-subagents agent working",
        "clear-status opencode-subagents",
      ])
      expect(
        harness.commands.filter((command) =>
          command.includes("Subagent finished: child-idle-event-3"),
        ),
      ).toHaveLength(1)
      expect(harness.commands.filter((command) => command.includes("close-surface"))).toHaveLength(3)
    },
    { splits: true },
  )
})
