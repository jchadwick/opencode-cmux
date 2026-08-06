import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  statusKey: string
  emit(event: unknown): Promise<void>
  permissionAsk(input: unknown): Promise<void>
  setSession(session: SessionInfo): void
}

const DEFAULT_STATUS_KEY = "opencode-subagents:surface:root"
const STARTUP_STATUS = [
  "clear-status opencode",
  "clear-status opencode-subagents",
  `set-status ${DEFAULT_STATUS_KEY} Idle --icon pause.circle.fill --color #8E8E93`,
]
const IDLE_STATUS = STARTUP_STATUS[2]
const RUNNING_STATUS =
  `set-status ${DEFAULT_STATUS_KEY} Running --icon bolt.fill --color #4C8DFF`
const NEEDS_INPUT_STATUS =
  `set-status ${DEFAULT_STATUS_KEY} Needs input --icon bell.fill --color #4C8DFF`

type ScheduledTimer = { at: number; callback: () => void }

let realSetTimeout: typeof setTimeout
let realClearTimeout: typeof clearTimeout
let timerNow = 0
let nextTimerID = 0
let scheduledTimers = new Map<number, ScheduledTimer>()

beforeEach(() => {
  realSetTimeout = globalThis.setTimeout
  realClearTimeout = globalThis.clearTimeout
  timerNow = 0
  nextTimerID = 0
  scheduledTimers = new Map()

  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const id = ++nextTimerID
    scheduledTimers.set(id, {
      at: timerNow + Math.max(0, delay ?? 0),
      callback: () => callback(...args),
    })
    return id as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: unknown) => {
    scheduledTimers.delete(Number(id))
  }) as typeof clearTimeout
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  scheduledTimers.clear()
})

function snapshotEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env }
}

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
  options: {
    deferDedicated?: boolean
    deferStartupClear?: boolean
    deferSplit?: boolean
  } = {},
): { shell: FakeShell; controller: ShellController } {
  const pending: DeferredShellCommand[] = []
  let inFlight = 0
  let maxInFlight = 0
  let dedicatedCommandsStarted = 0
  let startupClearDeferred = false

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
    const isDedicated = statusCommand(command).startsWith("set-status opencode-subagents:")
    if (isDedicated) dedicatedCommandsStarted++

    const isStartupClear = statusCommand(command) === "clear-status opencode"
    const deferSplit = options.deferSplit && command.includes("new-split")
    const deferStartupClear =
      options.deferStartupClear && isStartupClear && !startupClearDeferred
    if (deferStartupClear) startupClearDeferred = true

    // Let plugin initialization finish with its startup Idle command. Only
    // later dedicated renders are deferred for the FIFO test.
    if (
      !deferStartupClear &&
      !deferSplit &&
      (!options.deferDedicated || !isDedicated || dedicatedCommandsStarted === 1)
    ) {
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
  options: {
    splits?: boolean
    lookup?: Lookup
    surfaceID?: string | null
    deferDedicated?: boolean
    deferStartupClear?: boolean
    deferSplit?: boolean
  } = {},
): Promise<void> {
  const environment = snapshotEnvironment()
  const configHome = mkdtempSync(join(tmpdir(), "opencode-cmux-test-"))
  const configDirectory = join(configHome, "opencode")
  mkdirSync(configDirectory)

  try {
    process.env.CMUX_WORKSPACE_ID = "workspace:test"
    process.env.XDG_CONFIG_HOME = configHome
    if ("surfaceID" in options) {
      if (typeof options.surfaceID === "string") process.env.CMUX_SURFACE_ID = options.surfaceID
      else delete process.env.CMUX_SURFACE_ID
    } else {
      process.env.CMUX_SURFACE_ID = "surface:root"
    }
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
    const permissionHook = hooks["permission.ask"] as
      | ((input: unknown) => Promise<void>)
      | undefined
    if (!permissionHook) throw new Error("plugin did not register permission.ask")
    await settleRenders()

    await run({
      commands,
      shell: controller,
      statusKey: getStatusKey(process.env.CMUX_SURFACE_ID),
      emit: (event) => hooks.event!({ event } as never),
      permissionAsk: (input) => permissionHook(input),
      setSession: (session) => sessions.set(session.id, session),
    })
  } finally {
    rmSync(configHome, { recursive: true, force: true })
    restoreEnvironment(environment)
  }
}

async function settleRenders(): Promise<void> {
  advanceTimersBy(250)
  await settleMicrotasks()
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve()
}

function advanceTimersBy(milliseconds: number): void {
  const target = timerNow + milliseconds
  while (true) {
    const next = [...scheduledTimers.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort(([, left], [, right]) => left.at - right.at)[0]
    if (!next) break

    const [id, timer] = next
    scheduledTimers.delete(id)
    timerNow = timer.at
    timer.callback()
  }
  timerNow = target
}

function getStatusKey(surfaceID: string | undefined): string {
  const trimmed = surfaceID?.trim()
  return trimmed
    ? `opencode-subagents:${trimmed}`
    : `opencode-subagents:pid:${process.pid}`
}

function session(id: string, parentID?: string): SessionInfo {
  return { id, title: id, ...(parentID ? { parentID } : {}) }
}

function taskUpdate(
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
          ? {
              status,
              input: {},
              output: "done",
              title: "Task",
              metadata: {},
              time: { start: 1, end: 2 },
            }
          : { status, input: {}, error: "failed", time: { start: 1, end: 2 } }

  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        id: partID,
        sessionID,
        messageID,
        type: "tool",
        callID: `call-${partID}`,
        tool: "task",
        state,
      },
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
  return { type: "session.idle", properties: { sessionID } }
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

function permissionAsked(
  type: "permission.asked" | "permission.v2.asked" | "permission.updated",
  sessionID: string,
  id?: string,
  label = "run command",
) {
  const request =
    type === "permission.v2.asked"
      ? { action: label }
      : { title: label, permission: "shell" }
  return {
    type,
    properties: {
      ...(id === undefined ? {} : { id }),
      sessionID,
      ...request,
    },
  }
}

function permissionReplied(
  sessionID: string,
  requestID?: string,
  type: "permission.replied" | "permission.v2.replied" = "permission.replied",
  legacy = false,
) {
  return {
    type,
    properties: {
      sessionID,
      ...(requestID === undefined
        ? {}
        : legacy
          ? { permissionID: requestID, response: "reject" }
          : { requestID, reply: "reject" }),
    },
  }
}

function questionAsked(
  sessionID: string,
  id?: string,
  type: "question.asked" | "question.v2.asked" = "question.asked",
) {
  return {
    type,
    properties: {
      ...(id === undefined ? {} : { id }),
      sessionID,
      questions: [{ header: "Choose", question: "Choose", options: [] }],
    },
  }
}

function questionReplied(
  sessionID: string,
  requestID?: string,
  type: "question.replied" | "question.v2.replied" = "question.replied",
) {
  return {
    type,
    properties: {
      sessionID,
      ...(requestID === undefined ? {} : { requestID }),
      answers: [],
    },
  }
}

function questionRejected(
  sessionID: string,
  requestID?: string,
  type: "question.rejected" | "question.v2.rejected" = "question.rejected",
) {
  return {
    type,
    properties: {
      sessionID,
      ...(requestID === undefined ? {} : { requestID }),
    },
  }
}

function statusCommand(command: string): string {
  const set = command.indexOf("set-status ")
  if (set >= 0) return command.slice(set)
  const clear = command.indexOf("clear-status ")
  if (clear >= 0) return command.slice(clear)
  return ""
}

function statusCommands(commands: string[]): string[] {
  return commands
    .map(statusCommand)
    .filter(Boolean)
}

function dedicatedStatusCommands(commands: string[]): string[] {
  return statusCommands(commands).filter((command) =>
    command.startsWith("set-status opencode-subagents:"),
  )
}

function scopedStatusCommandsFor(commands: string[], key: string): string[] {
  return statusCommands(commands).filter((command) =>
    command.startsWith(`set-status ${key} `),
  )
}

function statusFor(key: string, text: string, icon: string, color: string): string {
  return `set-status ${key} ${text} --icon ${icon} --color ${color}`
}

function genericStatusCommands(commands: string[]): string[] {
  return statusCommands(commands).filter(
    (command) =>
      command.startsWith("set-status opencode ") ||
      command === "clear-status opencode",
  )
}

function notifications(commands: string[]): string[] {
  return commands.filter((command) => command.includes("rpc notification.create"))
}

function logs(commands: string[]): string[] {
  return commands.filter((command) => command.includes(" log "))
}

function subagentLogs(commands: string[]): string[] {
  return logs(commands).filter((command) => command.includes("Subagent finished:"))
}

function splitCloses(commands: string[]): string[] {
  return commands.filter((command) => command.includes("close-surface"))
}

function expectPersistentStatus(commands: string[], expected: string[]): void {
  expect(dedicatedStatusCommands(commands)).toEqual(expected)
  expect(genericStatusCommands(commands)).toEqual(["clear-status opencode"])
  expect(statusCommands(commands)).toContain("clear-status opencode-subagents")
}

test("serializes startup and matches status keys exactly", async () => {
  for (const finishStartup of ["resolve", "reject"] as const) {
    await withHarness(
      async (harness) => {
        expect(statusCommands(harness.commands)).toEqual(["clear-status opencode"])
        expect(genericStatusCommands(harness.commands)).toEqual(["clear-status opencode"])
        expect(dedicatedStatusCommands(harness.commands)).toEqual([])
        expect(harness.shell.inFlight).toBe(1)
        expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
          expect.stringContaining("clear-status opencode"),
        ])

        if (finishStartup === "resolve") harness.shell.releaseNext()
        else harness.shell.rejectNext()
        await settleRenders()

        expect(harness.shell.inFlight).toBe(0)
        expect(statusCommands(harness.commands)).toEqual(STARTUP_STATUS)
        expectPersistentStatus(harness.commands, [IDLE_STATUS])
      },
      { deferStartupClear: true },
    )
  }
})

test("renders running and idle for task lifecycle, parallelism, and cleanup", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "message-1", "task-1", "pending"))
    expectPersistentStatus(harness.commands, [IDLE_STATUS])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
  })

  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "message-a", "task-a", "running"))
    await harness.emit(taskUpdate("root", "message-b", "task-b", "running"))
    await harness.emit(partRemoved("root", "message-a", "task-a"))
    await harness.emit(partRemoved("root", "message-a", "task-a"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(messageRemoved("root", "message-b"))
    await harness.emit(messageRemoved("root", "message-b"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
  })
})

test("renders child busy/retry activity without changing legacy status or completion behavior", async () => {
  await withHarness(async (harness) => {
    const child = session("child-status", "root")
    harness.setSession(child)

    await harness.emit(sessionCreated(child))
    await harness.emit(taskUpdate("root", "message-error", "task-error", "running"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])
    await harness.emit(taskUpdate("root", "message-error", "task-error", "error"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])

    await harness.emit(sessionStatus("root", "busy"))
    await harness.emit(sessionStatus("root", "retry"))
    await harness.emit(sessionStatus(child.id, "busy"))
    await harness.emit(sessionStatus(child.id, "retry"))
    await harness.emit(sessionStatus(child.id, "busy"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
      RUNNING_STATUS,
    ])

    const secondChild = session("child-status-2", "root")
    harness.setSession(secondChild)
    await harness.emit(sessionCreated(secondChild))
    await harness.emit(sessionStatus(secondChild.id, "busy"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
      RUNNING_STATUS,
    ])

    await harness.emit(sessionStatus("root", "idle"))
    await harness.emit(sessionStatus(child.id, "idle"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
      RUNNING_STATUS,
    ])
    expect(subagentLogs(harness.commands)).toHaveLength(1)

    await harness.emit(sessionStatus(secondChild.id, "idle"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
    ])
    expect(subagentLogs(harness.commands)).toHaveLength(2)
    expect(notifications(harness.commands).filter((command) => command.includes("Done: root"))).toHaveLength(1)
    expect(logs(harness.commands).filter((command) => command.includes("Done: root"))).toHaveLength(1)
  })
})

test("keeps mixed task and session overlap Running until the final source clears", async () => {
  await withHarness(async (harness) => {
    const child = session("overlap-task-first", "root")
    harness.setSession(child)
    await harness.emit(sessionCreated(child))

    await harness.emit(taskUpdate("root", "overlap-message", "overlap-task", "running"))
    await harness.emit(sessionStatus(child.id, "busy"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(taskUpdate("root", "overlap-message", "overlap-task", "completed"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])
    await harness.emit(sessionStatus(child.id, "idle"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
  })

  await withHarness(async (harness) => {
    const child = session("overlap-session-first", "root")
    harness.setSession(child)
    await harness.emit(sessionCreated(child))

    await harness.emit(sessionStatus(child.id, "busy"))
    await harness.emit(taskUpdate("root", "overlap-message", "overlap-task", "running"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(sessionStatus(child.id, "idle"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])
    await harness.emit(taskUpdate("root", "overlap-message", "overlap-task", "error"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
  })
})

test("deleted sessions cannot be resurrected by late status, task, creation, or lookup events", async () => {
  let resolveLookup!: (result: LookupResult) => void
  const child = session("deleted-child", "root")
  const lookup = (sessionID: string): Promise<LookupResult> => {
    if (sessionID !== child.id) return Promise.resolve({})
    return new Promise((resolve) => {
      resolveLookup = resolve
    })
  }

  await withHarness(async (harness) => {
    const initialBusy = harness.emit(sessionStatus(child.id, "busy"))
    await Promise.resolve()
    await harness.emit(sessionDeleted(child))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])

    const lateBusy = harness.emit(sessionStatus(child.id, "busy"))
    const lateTask = harness.emit(
      taskUpdate(child.id, "deleted-message", "deleted-task", "running"),
    )
    const lateCreation = harness.emit(sessionCreated(child))
    const laterBusy = harness.emit(sessionStatus(child.id, "busy"))
    const latePermission = harness.emit(
      permissionAsked("permission.asked", child.id, "deleted-permission"),
    )
    const lateQuestion = harness.emit(questionAsked(child.id, "deleted-question"))
    await Promise.resolve()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
    expect(notifications(harness.commands)).toHaveLength(0)
    expect(logs(harness.commands)).toHaveLength(0)

    resolveLookup({ data: child })
    await Promise.all([
      initialBusy,
      lateBusy,
      lateTask,
      lateCreation,
      laterBusy,
      latePermission,
      lateQuestion,
    ])
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
    expect(notifications(harness.commands)).toHaveLength(0)
    expect(logs(harness.commands)).toHaveLength(0)
  }, { lookup })
})

test("does not complete a stale idle while an unknown child becomes busy again", async () => {
  let resolveLookup!: (result: LookupResult) => void
  const child = session("lookup-child", "root")
  let lookupStarted = false
  const lookup = (sessionID: string): Promise<LookupResult> => {
    if (sessionID !== child.id || lookupStarted) return Promise.resolve({ data: child })
    lookupStarted = true
    return new Promise((resolve) => {
      resolveLookup = resolve
    })
  }

  await withHarness(
    async (harness) => {
      const firstBusy = harness.emit(sessionStatus(child.id, "busy"))
      await Promise.resolve()
      const staleIdle = harness.emit(sessionStatus(child.id, "idle"))
      await Promise.resolve()
      const secondBusy = harness.emit(sessionStatus(child.id, "busy"))
      await Promise.resolve()
      const created = harness.emit(sessionCreated(child))
      await Promise.resolve()

      resolveLookup({ data: child })
      await Promise.all([firstBusy, staleIdle, secondBusy, created])
      await settleRenders()

      expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])
      expect(subagentLogs(harness.commands)).toHaveLength(0)
      expect(notifications(harness.commands)).toHaveLength(0)
      expect(harness.commands.filter((command) => command.includes("new-split"))).toHaveLength(1)
      expect(splitCloses(harness.commands)).toHaveLength(0)
    },
    { splits: true, lookup },
  )
})

test("keeps one valid idle completion when session.created arrives before lookup resolution", async () => {
  let resolveLookup!: (result: LookupResult) => void
  const child = session("idle-created-child", "root")
  const lookup = (sessionID: string): Promise<LookupResult> => {
    if (sessionID !== child.id) return Promise.resolve({})
    return new Promise((resolve) => {
      resolveLookup = resolve
    })
  }

  await withHarness(
    async (harness) => {
      const busy = harness.emit(sessionStatus(child.id, "busy"))
      await Promise.resolve()
      const idle = harness.emit(sessionStatus(child.id, "idle"))
      await Promise.resolve()
      const created = harness.emit(sessionCreated(child))
      await Promise.resolve()

      resolveLookup({ data: child })
      await Promise.all([busy, idle, created])
      await settleRenders()

      expectPersistentStatus(harness.commands, [
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
      ])
      expect(subagentLogs(harness.commands)).toHaveLength(1)
      expect(notifications(harness.commands)).toHaveLength(0)
      expect(harness.commands.filter((command) => command.includes("new-split"))).toHaveLength(0)
      expect(splitCloses(harness.commands)).toHaveLength(0)
    },
    { splits: true, lookup },
  )
})

test("errored sessions ignore late creation and tasks until genuine activity returns", async () => {
  await withHarness(async (harness) => {
    const child = session("errored-child", "root")
    harness.setSession(child)
    await harness.emit(sessionCreated(child))
    await harness.emit(sessionStatus(child.id, "busy"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(sessionError(child.id))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])

    await harness.emit(sessionCreated(child))
    await harness.emit(
      taskUpdate(child.id, "late-error-message", "late-error-task", "running"),
    )
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])

    await harness.emit(sessionStatus(child.id, "busy"))
    await harness.emit(sessionStatus(child.id, "retry"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
      RUNNING_STATUS,
    ])
  })
})

test("needs input takes precedence and uses the exact bell style without priority", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
    await harness.emit(permissionAsked("permission.asked", "root", "permission-1"))
    await harness.emit(questionAsked("root", "question-1"))
    await harness.emit(questionAsked("root", "question-2", "question.v2.asked"))
    await harness.emit(questionAsked("root", "question-3", "question.v2.asked"))
    await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
    await settleRenders()

    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      NEEDS_INPUT_STATUS,
    ])
    expect(NEEDS_INPUT_STATUS).not.toContain("priority")
    expect(notifications(harness.commands)).toHaveLength(4)
    expect(logs(harness.commands).filter((command) => command.includes("requested"))).toHaveLength(1)

    await harness.emit(permissionReplied("root", "permission-1"))
    await harness.emit(questionReplied("root", "question-1"))
    await harness.emit(
      questionReplied("root", "question-2", "question.v2.replied"),
    )
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      NEEDS_INPUT_STATUS,
    ])

    await harness.emit(
      questionRejected("root", "question-3", "question.v2.rejected"),
    )
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      RUNNING_STATUS,
      NEEDS_INPUT_STATUS,
      IDLE_STATUS,
    ])
  })
})

test("permission.ask announces without changing status and later event deduplicates", async () => {
  await withHarness(async (harness) => {
    await harness.permissionAsk({
      id: "permission-hook",
      sessionID: "root",
      title: "run command",
      permission: "shell",
    })
    expectPersistentStatus(harness.commands, [IDLE_STATUS])
    expect(notifications(harness.commands)).toHaveLength(1)
    expect(logs(harness.commands).filter((command) => command.includes("Permission requested:"))).toHaveLength(1)

    await harness.emit(permissionAsked("permission.asked", "root", "permission-hook"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, NEEDS_INPUT_STATUS])
    expect(notifications(harness.commands)).toHaveLength(1)
    expect(logs(harness.commands).filter((command) => command.includes("Permission requested:"))).toHaveLength(1)

    await harness.emit(permissionReplied("root", "permission-hook"))
    await settleRenders()
    await harness.emit(
      permissionAsked("permission.v2.asked", "root", "permission-v2", "install package"),
    )
    await harness.emit(
      permissionReplied("root", "permission-v2", "permission.v2.replied"),
    )
    await settleRenders()
    await harness.emit(
      permissionAsked("permission.updated", "root", "permission-legacy", "edit file"),
    )
    await harness.emit(
      permissionReplied("root", "permission-legacy", "permission.replied", true),
    )
    await settleRenders()
    expectPersistentStatus(harness.commands, [
      IDLE_STATUS,
      NEEDS_INPUT_STATUS,
      IDLE_STATUS,
      NEEDS_INPUT_STATUS,
      IDLE_STATUS,
      NEEDS_INPUT_STATUS,
      IDLE_STATUS,
    ])
    expect(notifications(harness.commands)).toHaveLength(3)
    expect(
      notifications(harness.commands).some((command) => command.includes("install package")),
    ).toBe(true)
    expect(
      notifications(harness.commands).every((command) => !command.includes('"body":"command"')),
    ).toBe(true)
    expect(logs(harness.commands).filter((command) => command.includes("Permission requested:"))).toHaveLength(3)
  })
})

test("keeps pending input scoped to sessions and ignores missing IDs", async () => {
  await withHarness(async (harness) => {
    await harness.emit(permissionAsked("permission.asked", "session-a"))
    await harness.emit(questionAsked("session-b"))
    expectPersistentStatus(harness.commands, [IDLE_STATUS])

    await harness.emit(permissionAsked("permission.asked", "session-a", "permission-a"))
    await harness.emit(permissionReplied("session-a"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, NEEDS_INPUT_STATUS])

    await harness.emit(questionAsked("session-b", "question-b"))
    await harness.emit(questionRejected("session-b"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, NEEDS_INPUT_STATUS])

    await harness.emit(sessionError("session-a"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, NEEDS_INPUT_STATUS])

    await harness.emit(questionRejected("session-b", "question-b"))
    await settleRenders()
    expectPersistentStatus(harness.commands, [IDLE_STATUS, NEEDS_INPUT_STATUS, IDLE_STATUS])
  })
})

test("deduplicates session.idle completion and supports later cycles", async () => {
  await withHarness(
    async (harness) => {
      const first = session("child-idle-1", "root")
      harness.setSession(first)
      await harness.emit(sessionCreated(first))
      await harness.emit(sessionStatus(first.id, "busy"))
      await settleRenders()
      await harness.emit(sessionIdle(first.id))
      await settleRenders()
      expect(subagentLogs(harness.commands)).toHaveLength(1)
      expect(splitCloses(harness.commands)).toHaveLength(1)
      expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])

      const second = session("child-idle-2", "root")
      harness.setSession(second)
      await harness.emit(sessionCreated(second))
      await harness.emit(sessionStatus(second.id, "busy"))
      const pairedIdle = [
        harness.emit(sessionStatus(second.id, "idle")),
        harness.emit(sessionIdle(second.id)),
      ]
      await Promise.all(pairedIdle)
      await settleRenders()
      expect(subagentLogs(harness.commands)).toHaveLength(2)
      expect(splitCloses(harness.commands)).toHaveLength(2)

      const third = session("child-idle-3", "root")
      harness.setSession(third)
      await harness.emit(sessionCreated(third))
      await harness.emit(sessionStatus(third.id, "busy"))
      await harness.emit(sessionStatus(third.id, "idle"))
      await settleRenders()
      expect(subagentLogs(harness.commands)).toHaveLength(3)
      expect(splitCloses(harness.commands)).toHaveLength(3)
      expectPersistentStatus(harness.commands, [
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
      ])
    },
    { splits: true },
  )
})

test("serializes rapid renders and recovers after a failed dedicated command", async () => {
  await withHarness(
    async (harness) => {
      await harness.emit(taskUpdate("root", "message-1", "task-1", "running"))
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending).toHaveLength(1)
      expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS])

      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(harness.shell.inFlight).toBe(0)
      expect(harness.shell.maxInFlight).toBe(1)

      await harness.emit(taskUpdate("root", "message-1", "task-1", "completed"))
      await settleRenders()
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("set-status opencode-subagents:"),
      ])

      harness.shell.releaseNext()
      await settleMicrotasks()
      await harness.emit(taskUpdate("root", "message-2", "task-2", "running"))
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("set-status opencode-subagents:"),
      ])

      harness.shell.rejectNext()
      await settleMicrotasks()
      await harness.emit(taskUpdate("root", "message-2", "task-2", "completed"))
      await settleRenders()
      expect(harness.shell.inFlight).toBe(1)
      expect(harness.shell.maxInFlight).toBe(1)
      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(harness.shell.inFlight).toBe(0)
      expect(harness.shell.pending).toHaveLength(0)
      expectPersistentStatus(harness.commands, [
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
        RUNNING_STATUS,
        IDLE_STATUS,
      ])
    },
    { deferDedicated: true },
  )
})

test("does not add a second transition when a child lookup resolves after idle", async () => {
  let lookupCount = 0
  let resolveLookup!: (result: LookupResult) => void
  const lookup = (sessionID: string): Promise<LookupResult> => {
    if (sessionID !== "unknown-child" || lookupCount++ > 0) return Promise.resolve({})
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
    await settleRenders()

    expectPersistentStatus(harness.commands, [IDLE_STATUS, RUNNING_STATUS, IDLE_STATUS])
  }, { lookup })
})

test("closes a split created after its session was deleted", async () => {
  await withHarness(
    async (harness) => {
      const child = session("late-split-child", "root")
      const created = harness.emit(sessionCreated(child))
      await Promise.resolve()
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("new-split"),
      ])

      await harness.emit(sessionDeleted(child))
      await settleRenders()
      expect(splitCloses(harness.commands)).toHaveLength(0)

      harness.shell.releaseNext()
      await created
      await settleRenders()

      expect(harness.commands.filter((command) => command.includes("new-split"))).toHaveLength(1)
      expect(splitCloses(harness.commands)).toHaveLength(1)
      expect(
        harness.commands.some((command) =>
          command.includes("close-surface --surface surface:subagent"),
        ),
      ).toBe(true)
      expect(harness.commands.some((command) => command.includes("opencode attach"))).toBe(false)
      expect(harness.commands.some((command) => command.includes(" send "))).toBe(false)
      expectPersistentStatus(harness.commands, [IDLE_STATUS])
    },
    { splits: true, deferSplit: true },
  )
})

test("closes a split when idle or error arrives during creation", async () => {
  for (const terminal of ["idle", "error"] as const) {
    await withHarness(
      async (harness) => {
        const child = session(`late-${terminal}-split`, "root")
        const created = harness.emit(sessionCreated(child))
        await Promise.resolve()
        expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
          expect.stringContaining("new-split"),
        ])

        const terminalEvent =
          terminal === "idle"
            ? harness.emit(sessionStatus(child.id, "idle"))
            : harness.emit(sessionError(child.id))
        await terminalEvent
        await settleRenders()
        expect(splitCloses(harness.commands)).toHaveLength(0)

        harness.shell.releaseNext()
        await created
        await settleRenders()

        expect(harness.commands.filter((command) => command.includes("new-split"))).toHaveLength(1)
        expect(splitCloses(harness.commands)).toHaveLength(1)
        expect(
          harness.commands.some((command) =>
            command.includes("close-surface --surface surface:subagent"),
          ),
        ).toBe(true)
        expect(harness.commands.some((command) => command.includes("opencode attach"))).toBe(false)
        expect(harness.commands.some((command) => command.includes(" send "))).toBe(false)
        expectPersistentStatus(harness.commands, [IDLE_STATUS])

        if (terminal === "idle") {
          expect(subagentLogs(harness.commands)).toHaveLength(1)
          expect(notifications(harness.commands)).toHaveLength(0)
        } else {
          expect(subagentLogs(harness.commands)).toHaveLength(0)
          expect(notifications(harness.commands)).toHaveLength(1)
        }
      },
      { splits: true, deferSplit: true },
    )
  }
})

test("uses one trimmed scoped key for each originating surface", async () => {
  const surfaceIDs = ["surface:one", " surface:two "]
  const observed: string[] = []

  for (const surfaceID of surfaceIDs) {
    await withHarness(async (harness) => {
      observed.push(harness.statusKey)
      expect(scopedStatusCommandsFor(harness.commands, harness.statusKey)).toEqual([
        statusFor(harness.statusKey, "Idle", "pause.circle.fill", "#8E8E93"),
      ])
    }, { surfaceID })
  }

  expect(observed).toEqual([
    "opencode-subagents:surface:one",
    "opencode-subagents:surface:two",
  ])
  expect(new Set(observed).size).toBe(2)
})

test("uses the PID fallback for blank and missing surface IDs", async () => {
  for (const surfaceID of ["", "   ", null] as const) {
    await withHarness(async (harness) => {
      expect(harness.statusKey).toBe(`opencode-subagents:pid:${process.pid}`)
      expect(scopedStatusCommandsFor(harness.commands, harness.statusKey)).toEqual([
        statusFor(harness.statusKey, "Idle", "pause.circle.fill", "#8E8E93"),
      ])
    }, { surfaceID })
  }
})

test("startup migration clears exactly both legacy keys and no scoped key", async () => {
  await withHarness(async (harness) => {
    expect(statusCommands(harness.commands)).toEqual(STARTUP_STATUS)
    expect(statusCommands(harness.commands)).not.toContain(
      `clear-status ${harness.statusKey}`,
    )
    expect(statusCommands(harness.commands)).not.toContain("clear-status opencode-subagents:")
  })
})

test("activity arriving while legacy cleanup is blocked publishes Running without startup Idle", async () => {
  await withHarness(
    async (harness) => {
      expect(statusCommands(harness.commands)).toEqual(["clear-status opencode"])

      await harness.emit(taskUpdate("root", "startup-message", "startup-task", "running"))
      await settleMicrotasks()
      expect(statusCommands(harness.commands)).toEqual(["clear-status opencode"])

      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(statusCommands(harness.commands)).toEqual([
        "clear-status opencode",
        "clear-status opencode-subagents",
        RUNNING_STATUS,
      ])
      expect(scopedStatusCommandsFor(harness.commands, harness.statusKey)).toEqual([
        RUNNING_STATUS,
      ])
    },
    { deferStartupClear: true },
  )
})

test("renders Running and Needs input immediately", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "immediate-message", "immediate-task", "running"))
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([IDLE_STATUS, RUNNING_STATUS])

    await harness.emit(permissionAsked("permission.asked", "root", "immediate-permission"))
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      IDLE_STATUS,
      RUNNING_STATUS,
      NEEDS_INPUT_STATUS,
    ])
  })
})

test("does not render Idle at 249ms, then renders it once at 250ms", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "stable-message", "stable-task", "running"))
    await settleMicrotasks()
    await harness.emit(taskUpdate("root", "stable-message", "stable-task", "completed"))

    advanceTimersBy(249)
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([IDLE_STATUS, RUNNING_STATUS])

    advanceTimersBy(1)
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
    ])

    advanceTimersBy(250)
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([
      IDLE_STATUS,
      RUNNING_STATUS,
      IDLE_STATUS,
    ])
  })
})

test("suppresses an Idle render for Running to Idle to Running", async () => {
  await withHarness(async (harness) => {
    await harness.emit(taskUpdate("root", "bounce-message", "bounce-task", "running"))
    await settleMicrotasks()
    await harness.emit(taskUpdate("root", "bounce-message", "bounce-task", "completed"))
    await harness.emit(taskUpdate("root", "bounce-message-2", "bounce-task-2", "running"))

    advanceTimersBy(250)
    await settleMicrotasks()
    expect(dedicatedStatusCommands(harness.commands)).toEqual([IDLE_STATUS, RUNNING_STATUS])
  })
})

test("reconciles a timer-fired Idle render when activity arrives while it is blocked", async () => {
  await withHarness(
    async (harness) => {
      await harness.emit(taskUpdate("root", "blocked-message", "blocked-task", "running"))
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("set-status opencode-subagents:"),
      ])
      harness.shell.releaseNext()
      await settleMicrotasks()

      await harness.emit(taskUpdate("root", "blocked-message", "blocked-task", "completed"))
      advanceTimersBy(250)
      await settleMicrotasks()
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining(" Idle"),
      ])

      await harness.emit(taskUpdate("root", "blocked-message-2", "blocked-task-2", "running"))
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        IDLE_STATUS,
        RUNNING_STATUS,
        statusFor(harness.statusKey, "Idle", "pause.circle.fill", "#8E8E93"),
      ])

      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("Running"),
      ])
      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(dedicatedStatusCommands(harness.commands).at(-1)).toBe(RUNNING_STATUS)
    },
    { deferDedicated: true },
  )
})

test("finishes at the latest state when a status command is in flight", async () => {
  await withHarness(
    async (harness) => {
      await harness.emit(taskUpdate("root", "latest-message", "latest-task", "running"))
      await harness.emit(permissionAsked("permission.asked", "root", "latest-permission"))
      expect(dedicatedStatusCommands(harness.commands)).toEqual([IDLE_STATUS, RUNNING_STATUS])
      expect(harness.shell.pending).toHaveLength(1)

      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(harness.shell.pending.map((operation) => operation.command)).toEqual([
        expect.stringContaining("Needs input"),
      ])

      harness.shell.releaseNext()
      await settleMicrotasks()
      expect(dedicatedStatusCommands(harness.commands)).toEqual([
        IDLE_STATUS,
        RUNNING_STATUS,
        NEEDS_INPUT_STATUS,
      ])
    },
    { deferDedicated: true },
  )
})
