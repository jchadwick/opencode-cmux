import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function makeClock() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let now = 0
  const timers = new Map<object, { at: number; callback: () => void }>()

  globalThis.setTimeout = ((callback: () => void, delay = 0, ...args: unknown[]) => {
    // Keep Bun's test timeout on the real timer implementation.
    if (delay > 1000) return realSetTimeout(callback, delay, ...args) as any
    const timer = {}
    timers.set(timer, { at: now + delay, callback: () => callback(...(args as [])) })
    return timer as any
  }) as any
  globalThis.clearTimeout = ((timer: any) => {
    if (timers.delete(timer)) return
    realClearTimeout(timer)
  }) as any

  return {
    async advance(milliseconds: number): Promise<void> {
      now += milliseconds
      let timer: { at: number; callback: () => void } | undefined
      do {
        timer = [...timers.entries()]
          .filter(([, value]) => value.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0]?.[1]
        if (!timer) break
        const entry = [...timers.entries()].find(([, value]) => value === timer)
        if (entry) timers.delete(entry[0])
        timer.callback()
        await flush()
      } while (timer)
    },
    restore(): void {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      timers.clear()
    },
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

function makeShell() {
  const calls: string[] = []
  let blockedNeedle: string | undefined
  let blockedGate: Deferred<void> | undefined
  let failNextStatus = false

  const shell = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce((text, part, index) => {
      const value = values[index]
      return text + part + (index < values.length
        ? Array.isArray(value) ? value.join(" ") : String(value ?? "")
        : "")
    }, "")
    calls.push(command)
    const result = {
      exitCode: 0,
      stdout: Buffer.from(""),
      text: () => (command.includes("new-split") ? "OK surface:5 workspace:1" : ""),
    }
    const wrapper = {
      quiet: () => wrapper,
      nothrow: async () => {
        if (blockedNeedle && command.includes(blockedNeedle)) {
          const gate = blockedGate
          if (gate) await gate.promise
        }
        if (failNextStatus && command.includes("set-status")) {
          failNextStatus = false
          throw new Error("cmux failure")
        }
        return result
      },
    }
    return wrapper
  }) as any

  return {
    shell,
    calls,
    block(needle: string): void {
      blockedNeedle = needle
      blockedGate = deferred<void>()
    },
    release(): void {
      blockedNeedle = undefined
      blockedGate?.resolve(undefined)
      blockedGate = undefined
    },
    failStatusOnce(): void {
      failNextStatus = true
    },
  }
}

async function makeHarness(options: { surface?: string; splits?: boolean; directory?: string } = {}) {
  const configHome = mkdtempSync(join(tmpdir(), "opencode-cmux-test-"))
  mkdirSync(join(configHome, "opencode"))
  writeFileSync(
    join(configHome, "opencode", "opencode-cmux.json"),
    JSON.stringify({ splits: options.splits === true }),
  )
  process.env.XDG_CONFIG_HOME = configHome
  process.env.CMUX_WORKSPACE_ID = "workspace:test"
  if (options.surface === undefined) delete process.env.CMUX_SURFACE_ID
  else process.env.CMUX_SURFACE_ID = options.surface
  if (options.splits) process.env.OPENCODE_SERVER_URL = "http://localhost:9731"
  else delete process.env.OPENCODE_SERVER_URL

  const fake = makeShell()
  const sessionData = new Map<string, { title: string; parentID: string | null }>()
  const lookups: string[] = []
  let lookupGate: Deferred<void> | undefined
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        lookups.push(path.id)
        if (lookupGate) await lookupGate.promise
        return { data: sessionData.get(path.id) }
      },
    },
  }
  const hooks = await plugin({
    client,
    $: fake.shell,
    directory: options.directory ?? "/test/project",
  } as any)
  return {
    ...fake,
    hooks,
    sessionData,
    lookups,
    blockLookup(): void { lookupGate = deferred<void>() },
    releaseLookup(): void { lookupGate?.resolve(undefined); lookupGate = undefined },
    cleanup(): void { rmSync(configHome, { recursive: true, force: true }) },
  }
}

async function runCase(
  body: (make: typeof makeHarness, clock: ReturnType<typeof makeClock>) => Promise<void>,
): Promise<void> {
  const saved = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
    OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL,
  }
  const harnesses: Array<{ cleanup(): void }> = []
  const clock = makeClock()
  const make = async (options?: Parameters<typeof makeHarness>[0]) => {
    const harness = await makeHarness(options)
    harnesses.push(harness)
    await flush()
    return harness
  }
  try {
    await body(make as typeof makeHarness, clock)
  } finally {
    for (const harness of harnesses) harness.cleanup()
    clock.restore()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function prime(harness: any, clock: ReturnType<typeof makeClock>): Promise<string[]> {
  const startup = [...harness.calls]
  await clock.advance(250)
  startup.push(...harness.calls.slice(startup.length))
  harness.calls.length = 0
  return startup
}

async function event(hooks: any, type: string, properties: any = {}): Promise<void> {
  await hooks.event({ event: { type, properties } })
}

function taskPart(sessionID: string, messageID: string, id: string, status: string) {
  return {
    id,
    sessionID,
    messageID,
    type: "tool",
    tool: "task",
    state: { status },
  }
}

function statuses(calls: string[]): string[] {
  return calls.filter((call) => call.includes(" set-status "))
}

function normalize(command: string): string {
  return command.replace(/^.*\/cmux /, "cmux ")
}

test("startup FIFO migrates generic keys and scopes surface or PID status", async () => {
  await runCase(async (make, clock) => {
    const surface = await make({ surface: "  surface:7  " })
    const startup = (await prime(surface, clock)).map(normalize)
    expect(startup.slice(0, 2)).toEqual([
      "cmux clear-status opencode",
      "cmux clear-status opencode-subagents",
    ])
    expect(startup).toContain(
      "cmux set-status opencode-subagents:surface:7 Idle --icon pause.circle.fill --color #8E8E93",
    )
    expect(startup.some((call) => call.includes("set-status opencode Idle"))).toBe(false)

    const pid = await make()
    expect((await prime(pid, clock)).map(normalize)).toContain(
      `cmux set-status opencode-subagents:pid:${process.pid} Idle --icon pause.circle.fill --color #8E8E93`,
    )
  })
})

test("session identity keeps primary, child, and unknown parent states distinct", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "identity" })
    await prime(harness, clock)
    await event(harness.hooks, "session.created", { info: { id: "created-primary" } })
    await event(harness.hooks, "session.status", { sessionID: "created-primary", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "created-primary", status: { type: "retry" } })
    await event(harness.hooks, "session.created", { info: { id: "blank-primary", parentID: "  " } })
    await event(harness.hooks, "session.status", { sessionID: "blank-primary", status: { type: "busy" } })
    expect(harness.lookups).toEqual([])

    harness.sessionData.set("lookup-primary", { title: "Primary", parentID: " " })
    await event(harness.hooks, "session.status", { sessionID: "lookup-primary", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "lookup-primary", status: { type: "retry" } })
    expect(harness.lookups).toEqual(["lookup-primary"])

    harness.sessionData.set("lookup-child", { title: "Child", parentID: "parent" })
    await event(harness.hooks, "session.status", { sessionID: "lookup-child", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "lookup-child", status: { type: "retry" } })
    expect(harness.lookups).toEqual(["lookup-primary", "lookup-child"])

    await event(harness.hooks, "session.status", { sessionID: "missing", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "missing", status: { type: "retry" } })
    expect(harness.lookups).toEqual(["lookup-primary", "lookup-child", "missing", "missing"])
    await clock.advance(250)
  })
})

test("status FIFO starts immediately, reconciles latest state, and recovers after failure", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "status" })
    await prime(harness, clock)
    harness.block("set-status")
    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    await event(harness.hooks, "permission.asked", { id: "permission", sessionID: "p" })
    harness.release()
    await flush()
    expect(statuses(harness.calls).at(-1)).toContain(" Needs input ")

    const failure = await make({ surface: "failure" })
    await prime(failure, clock)
    failure.failStatusOnce()
    await event(failure.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    await event(failure.hooks, "permission.asked", { id: "permission", sessionID: "p" })
    await flush()
    expect(statuses(failure.calls).at(-1)).toContain(" Needs input ")
  })
})

test("disposal suppresses blocked render and completion, closes splits, and clears only its key", async () => {
  await runCase(async (make, clock) => {
    const render = await make({ surface: "dispose", directory: "/dispose" })
    await prime(render, clock)
    render.block("set-status")
    await event(render.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    await event(render.hooks, "server.instance.disposed", { directory: "/other" })
    expect(render.calls.some((call) => call.includes("clear-status opencode-subagents:dispose"))).toBe(false)
    await event(render.hooks, "server.instance.disposed", { directory: "/dispose" })
    render.release()
    await flush()
    const beforeLateEvent = [...render.calls]
    await event(render.hooks, "session.status", { sessionID: "later", status: { type: "busy" } })
    expect(render.calls).toEqual(beforeLateEvent)
    expect(render.calls.at(-1)).toContain("clear-status opencode-subagents:dispose")

    const completion = await make({ surface: "completion", directory: "/completion" })
    await prime(completion, clock)
    completion.blockLookup()
    const idle = event(completion.hooks, "session.idle", { sessionID: "unknown" })
    await flush()
    await event(completion.hooks, "server.instance.disposed", { directory: "/completion" })
    completion.releaseLookup()
    await idle
    expect(completion.calls.some((call) => call.includes("Done:"))).toBe(false)
    expect(completion.calls.some((call) => call.includes("Subagent finished"))).toBe(false)
    expect(completion.calls.at(-1)).toContain("clear-status opencode-subagents:completion")

    const blockedCompletion = await make({ surface: "blocked", directory: "/blocked" })
    await prime(blockedCompletion, clock)
    await event(blockedCompletion.hooks, "session.created", {
      info: { id: "primary", title: "Primary", parentID: null },
    })
    blockedCompletion.block("rpc notification.create")
    const done = event(blockedCompletion.hooks, "session.idle", { sessionID: "primary" })
    await flush()
    await event(blockedCompletion.hooks, "server.instance.disposed", { directory: "/blocked" })
    blockedCompletion.release()
    await done
    expect(blockedCompletion.calls.filter((call) => call.includes("Done: Primary"))).toHaveLength(1)
    expect(blockedCompletion.calls.some((call) => call.includes("--level success"))).toBe(false)

    const deferredError = await make({ surface: "error-dispose", directory: "/error-dispose" })
    await prime(deferredError, clock)
    deferredError.blockLookup()
    const error = event(deferredError.hooks, "session.error", { sessionID: "error" })
    await flush()
    expect(deferredError.lookups).toEqual(["error"])
    await event(deferredError.hooks, "server.instance.disposed", { directory: "/error-dispose" })
    deferredError.releaseLookup()
    await error
    expect(deferredError.calls.some((call) => call.includes("Error:"))).toBe(false)
    expect(deferredError.calls.at(-1)).toContain("clear-status opencode-subagents:error-dispose")

    const splits = await make({ splits: true, surface: "split", directory: "/split" })
    await prime(splits, clock)
    await event(splits.hooks, "session.created", {
      info: { id: "child", parentID: "parent" },
    })
    await flush()
    await event(splits.hooks, "server.instance.disposed", { directory: "/split" })
    await flush()
    expect(splits.calls.some((call) => call.includes("close-surface"))).toBe(true)
  })
})

test("tasks aggregate, ignore pending parts, and remove by part or message", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "tasks" })
    await prime(harness, clock)
    await event(harness.hooks, "message.part.updated", { part: taskPart("p", "m", "pending", "pending") })
    expect(statuses(harness.calls)).toEqual([])
    await event(harness.hooks, "message.part.updated", { part: taskPart("p", "m", "one", "running") })
    await event(harness.hooks, "message.part.updated", { part: taskPart("p", "m", "two", "running") })
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    await event(harness.hooks, "message.part.updated", { part: taskPart("p", "m", "one", "error") })
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    await event(harness.hooks, "message.part.removed", { sessionID: "p", messageID: "m", partID: "two" })
    await clock.advance(250)
    expect(statuses(harness.calls).at(-1)).toContain(" Idle ")
    await event(harness.hooks, "message.part.updated", { part: taskPart("p", "m", "three", "running") })
    await event(harness.hooks, "message.removed", { sessionID: "p", messageID: "m" })
    await clock.advance(250)
    expect(statuses(harness.calls).at(-1)).toContain(" Idle ")
  })
})

test("parent and child busy/retry aggregation supports paired idle and new cycles", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "sessions" })
    await prime(harness, clock)
    await event(harness.hooks, "session.created", { info: { id: "parent", title: "P", parentID: null } })
    await event(harness.hooks, "session.created", { info: { id: "child", title: "C", parentID: "parent" } })
    await event(harness.hooks, "session.status", { sessionID: "parent", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "child", status: { type: "retry" } })
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    await event(harness.hooks, "session.status", { sessionID: "child", status: { type: "idle" } })
    await event(harness.hooks, "session.idle", { sessionID: "child" })
    expect(harness.calls.filter((call) => call.includes("Subagent finished"))).toHaveLength(1)
    await event(harness.hooks, "session.status", { sessionID: "child", status: { type: "busy" } })
    await event(harness.hooks, "session.idle", { sessionID: "child" })
    expect(harness.calls.filter((call) => call.includes("Subagent finished"))).toHaveLength(2)
    await event(harness.hooks, "session.idle", { sessionID: "parent" })
    expect(harness.calls.some((call) => call.includes("Done: P"))).toBe(true)
    await clock.advance(250)
  })
})

test("Idle is exactly debounced and pending input defers completion until a later idle", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "idle" })
    await prime(harness, clock)
    await event(harness.hooks, "session.created", { info: { id: "p", title: "P", parentID: null } })
    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "idle" } })
    await clock.advance(249)
    expect(statuses(harness.calls).some((call) => call.includes(" Idle "))).toBe(false)
    await clock.advance(1)
    expect(statuses(harness.calls).at(-1)).toContain(" Idle ")

    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "idle" } })
    const idleCount = statuses(harness.calls).filter((call) => call.includes(" Idle ")).length
    await clock.advance(249)
    await event(harness.hooks, "session.status", { sessionID: "p", status: { type: "busy" } })
    await clock.advance(1)
    expect(statuses(harness.calls).filter((call) => call.includes(" Idle ")).length).toBe(idleCount)

    await event(harness.hooks, "session.created", { info: { id: "pending", title: "Pending", parentID: null } })
    await event(harness.hooks, "session.status", { sessionID: "pending", status: { type: "busy" } })
    await event(harness.hooks, "permission.asked", { id: "permission", sessionID: "pending" })
    await event(harness.hooks, "session.idle", { sessionID: "pending" })
    await event(harness.hooks, "permission.replied", { requestID: "permission" })
    await clock.advance(250)
    expect(harness.calls.filter((call) => call.includes("Done: Pending"))).toHaveLength(0)
    await event(harness.hooks, "session.idle", { sessionID: "pending" })
    expect(harness.calls.some((call) => call.includes("Done: Pending"))).toBe(true)
  })
})

test("permission and question IDs, versions, fallbacks, missing IDs, and hook dedupe are preserved", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "input" })
    await prime(harness, clock)
    await harness.hooks["permission.ask"]({ id: "hook", title: "command" })
    await harness.hooks["permission.ask"]({ title: "no id" })
    expect(statuses(harness.calls)).toEqual([])
    await event(harness.hooks, "permission.asked", { id: " hook ", sessionID: "p", title: "command" })
    await event(harness.hooks, "permission.updated", { permissionID: "hook", sessionID: "p" })
    expect(harness.calls.filter((call) => call.includes("Needs your permission"))).toHaveLength(2)
    await event(harness.hooks, "permission.v2.asked", { id: "", requestID: "v2", sessionID: "p" })
    await event(harness.hooks, "permission.v2.replied", { id: "", permissionID: "v2" })
    await event(harness.hooks, "permission.replied", { requestID: "hook" })

    const beforeMissing = harness.calls.length
    await event(harness.hooks, "permission.asked", { id: " ", sessionID: "p" })
    await event(harness.hooks, "question.v2.asked", { id: "", requestID: "  " })
    expect(harness.calls.length).toBe(beforeMissing)
    await event(harness.hooks, "question.asked", { id: "legacy-question", questions: [{ header: "Legacy" }] })
    await event(harness.hooks, "question.v2.asked", { id: "v2-question", questions: [{ header: "V2" }] })
    expect(statuses(harness.calls).at(-1)).toContain(" Needs input ")
    await event(harness.hooks, "question.replied", { requestID: "legacy-question" })
    await event(harness.hooks, "question.v2.rejected", { id: "v2-question" })
    await clock.advance(250)
  })
})

test("errors clean owned state, sessionless errors clear all state, and busy can revive", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "errors" })
    await prime(harness, clock)
    harness.sessionData.set("bad", { title: "Bad", parentID: null })
    await event(harness.hooks, "session.status", { sessionID: "bad", status: { type: "busy" } })
    await event(harness.hooks, "message.part.updated", { part: taskPart("bad", "m", "tool", "running") })
    await event(harness.hooks, "permission.asked", { id: "bad-permission", sessionID: "bad" })
    await event(harness.hooks, "session.error", { sessionID: "bad" })
    expect(harness.calls.some((call) => call.includes("Error: Bad"))).toBe(true)
    await event(harness.hooks, "session.status", { sessionID: "bad", status: { type: "retry" } })
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    await event(harness.hooks, "permission.asked", { id: "other", sessionID: "other" })
    await event(harness.hooks, "permission.asked", { id: "stale", sessionID: "other" })
    const staleAnnouncements = harness.calls.filter((call) => call.includes("Needs your permission")).length
    const lookups = harness.lookups.length
    await event(harness.hooks, "session.error", {})
    expect(harness.calls.some((call) => call.includes("Error: unknown session"))).toBe(true)
    expect(harness.lookups.length).toBe(lookups)
    await event(harness.hooks, "permission.asked", { id: "stale", sessionID: "other" })
    expect(harness.calls.filter((call) => call.includes("Needs your permission"))).toHaveLength(staleAnnouncements + 1)
    await clock.advance(250)
  })
})

test("deletion invalidates late lookup and keeps a bounded insertion-ordered tombstone set", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "deleted" })
    await prime(harness, clock)
    harness.blockLookup()
    const idle = event(harness.hooks, "session.idle", { sessionID: "late" })
    await flush()
    await event(harness.hooks, "session.deleted", { info: { id: "late" } })
    harness.releaseLookup()
    await idle
    expect(harness.calls.some((call) => call.includes("Done:"))).toBe(false)
    expect(harness.lookups).toEqual(["late"])
    await event(harness.hooks, "session.status", { sessionID: "owned", status: { type: "busy" } })
    await event(harness.hooks, "message.part.updated", { part: taskPart("owned", "m", "tool", "running") })
    await event(harness.hooks, "permission.asked", { id: "owned-permission", sessionID: "owned" })
    await event(harness.hooks, "session.deleted", { info: { id: "owned" } })
    await clock.advance(250)
    expect(statuses(harness.calls).at(-1)).toContain(" Idle ")
    for (let index = 0; index < 1025; index++) {
      await event(harness.hooks, "session.deleted", { info: { id: `tombstone-${index}` } })
    }
    await event(harness.hooks, "session.idle", { sessionID: "tombstone-1024" })
    expect(harness.lookups).toEqual(["late", "owned"])
    await event(harness.hooks, "session.idle", { sessionID: "tombstone-0" })
    expect(harness.lookups).toEqual(["late", "owned", "tombstone-0"])
    await clock.advance(250)
  })
})

test("busy classification starts immediately, waits for lookup, and cannot resurrect a deleted session", async () => {
  await runCase(async (make, clock) => {
    const harness = await make({ surface: "busy-lookup" })
    await prime(harness, clock)
    harness.sessionData.set("child", { title: "Child", parentID: "parent" })
    harness.blockLookup()
    let settled = false
    const busy = event(harness.hooks, "session.status", {
      sessionID: "child",
      status: { type: "busy" },
    }).then(() => { settled = true })
    await flush()
    expect(harness.lookups).toEqual(["child"])
    expect(statuses(harness.calls).at(-1)).toContain(" Running ")
    expect(settled).toBe(false)
    await event(harness.hooks, "session.deleted", { info: { id: "child" } })
    harness.releaseLookup()
    await busy
    expect(settled).toBe(true)
    await event(harness.hooks, "session.idle", { sessionID: "child" })
    expect(harness.lookups).toEqual(["child"])
    expect(harness.calls.some((call) => call.includes("Child"))).toBe(false)
    await clock.advance(250)
  })
})

async function splitInterruptedBy(kind: "idle" | "error" | "delete"): Promise<void> {
  await runCase(async (make, clock) => {
    const harness = await make({ splits: true, surface: `split-${kind}` })
    await prime(harness, clock)
    harness.block("new-split")
    await event(harness.hooks, "session.created", { info: { id: "child", parentID: "parent" } })
    await flush()
    if (kind === "idle") await event(harness.hooks, "session.idle", { sessionID: "child" })
    if (kind === "error") await event(harness.hooks, "session.error", { sessionID: "child" })
    if (kind === "delete") await event(harness.hooks, "session.deleted", { info: { id: "child" } })
    harness.release()
    await flush()
    expect(harness.calls.some((call) => call.includes("close-surface"))).toBe(true)
    await clock.advance(250)
  })
}

test("split creation interrupted by idle closes the created surface", () => splitInterruptedBy("idle"))
test("split creation interrupted by error closes the created surface", () => splitInterruptedBy("error"))
test("split creation interrupted by deletion closes the created surface", () => splitInterruptedBy("delete"))
