import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LSOF_LISTEN_RE } from "./lsof.js"
import {
  notify,
  setStatus,
  clearStatus,
  log,
  createSplit,
  closeSurface,
  focusSurface,
  sendToSurface,
  sendKeyToSurface,
  type SplitDirection,
} from "./cmux.js"

const plugin: Plugin = async ({ client, $ }) => {
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()

  const originalSurfaceId = process.env.CMUX_SURFACE_ID

  // Read plugin config (once at init)
  let splitsEnabled = false
  const notifyOn: { done: boolean; permission: boolean; question: boolean; error: boolean } = {
    done: true,
    permission: true,
    question: true,
    error: true,
  }
  try {
    // Respect XDG_CONFIG_HOME, fall back to ~/.config per the XDG Base
    // Directory Specification (https://specifications.freedesktop.org/basedir-spec/).
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const configPath = join(configDir, "opencode", "opencode-cmux.json")
    const raw = readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw)
    if (config.splits === true) {
      splitsEnabled = true
    }
    if (config.notifications !== undefined) {
      if (
        typeof config.notifications === "object" &&
        config.notifications !== null &&
        !Array.isArray(config.notifications)
      ) {
        const n = config.notifications as Record<string, unknown>
        for (const key of ["done", "permission", "question", "error"] as const) {
          const v = n[key]
          if (v === undefined) continue
          if (v === false) notifyOn[key] = false
          else if (v === true) notifyOn[key] = true
          else {
            console.warn(
              `[opencode-cmux] config.notifications.${key} ignored: expected boolean, got ${typeof v}`,
            )
          }
        }
      } else {
        const got = Array.isArray(config.notifications)
          ? "array"
          : typeof config.notifications
        console.warn(
          `[opencode-cmux] config.notifications ignored: expected object, got ${got}`,
        )
      }
    }
  } catch {
    // File missing, unreadable, or invalid JSON — use defaults
  }

  // Discover the actual server URL for `opencode attach`.
  //
  // The TUI does not start an HTTP server unless --port is passed.
  // Neither the serverUrl plugin input nor the SDK client baseUrl are
  // reliable — both report http://localhost:4096 regardless of the
  // actual bound port (the SDK uses in-process fetch, not HTTP).
  //
  // We use lsof to find the TCP port this process is actually listening on.
  // Returns null when no HTTP server is running (splits are skipped).
  // See: https://github.com/anomalyco/opencode/issues/9099
  let discoveredServerUrl: string | null | undefined
  function resolveServerUrl(): string | null {
    if (discoveredServerUrl !== undefined) return discoveredServerUrl

    // 1. Env var (future-proof for when anomalyco/opencode#9099 lands)
    if (process.env.OPENCODE_SERVER_URL) {
      try {
        const parsed = new URL(process.env.OPENCODE_SERVER_URL)
        if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") {
          parsed.hostname = "localhost"
        }
        discoveredServerUrl = parsed.toString().replace(/\/$/, "")
        return discoveredServerUrl
      } catch {}
    }

    // 2. Find the TCP port this process is listening on via lsof.
    //    Use -a to AND the -p and -iTCP filters (macOS lsof ORs by default).
    try {
      const out = execSync(
        `lsof -nP -a -p ${process.pid} -iTCP -sTCP:LISTEN 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 },
      )
      for (const line of out.split("\n")) {
        const match = line.match(LSOF_LISTEN_RE)
        if (match) {
          discoveredServerUrl = `http://localhost:${match[1]}`
          return discoveredServerUrl
        }
      }
    } catch {}

    discoveredServerUrl = null
    return null
  }

  const activeSplits = new Map<string, string>()

  type SessionActivityStatus = "busy" | "retry" | "idle"
  type SessionRecord = {
    known: boolean
    isChild: boolean
    parentID?: string
    title?: string
    active: boolean
    latestStatus?: SessionActivityStatus
    deleted: boolean
    errored: boolean
    idleHandled: boolean
  }

  // These are intentionally private to this plugin instance. A task part can
  // outlive a session status event, so session activity and task-part activity
  // are reduced independently and then combined into one boolean.
  const activeTaskParts = new Map<string, Map<string, Set<string>>>()
  const sessionRecords = new Map<string, SessionRecord>()
  const sessionLookups = new Map<string, Promise<{ title: string; parentID?: string } | null>>()
  const childLookups = new Map<string, Promise<void>>()

  let subagentsVisible = false
  let subagentStatusQueue = Promise.resolve()

  function hasActiveTaskParts(): boolean {
    for (const messages of activeTaskParts.values()) {
      for (const partIDs of messages.values()) {
        if (partIDs.size > 0) return true
      }
    }
    return false
  }

  function hasActiveChildSessions(): boolean {
    for (const session of sessionRecords.values()) {
      if (session.isChild && session.active && !session.deleted && !session.errored) {
        return true
      }
    }
    return false
  }

  function enqueueSubagentStatus(visible: boolean): void {
    const operation = () =>
      visible
        ? setStatus($, "opencode-subagents", "agent working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        : clearStatus($, "opencode-subagents")

    // Recover the tail after every operation. The renderer is best effort and
    // must not prevent a later transition from being sent.
    subagentStatusQueue = subagentStatusQueue.then(operation, operation).catch(() => {})
  }

  function updateSubagentVisibility(): void {
    const visible = hasActiveTaskParts() || hasActiveChildSessions()
    if (visible === subagentsVisible) return

    // Set the desired state synchronously, before the renderer can be awaited.
    subagentsVisible = visible
    enqueueSubagentStatus(visible)
  }

  function getID(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.trim().length > 0
      ? value
      : undefined
  }

  function getSessionRecord(sessionID: string): SessionRecord {
    const existing = sessionRecords.get(sessionID)
    if (existing) return existing

    const record: SessionRecord = {
      known: false,
      isChild: false,
      active: false,
      deleted: false,
      errored: false,
      idleHandled: false,
    }
    sessionRecords.set(sessionID, record)
    return record
  }

  function isActiveSessionStatus(
    status: SessionActivityStatus | undefined,
  ): status is "busy" | "retry" {
    return status === "busy" || status === "retry"
  }

  function reduceSessionCreated(info: any): void {
    const sessionID = getID(info?.id)
    if (!sessionID) return

    const parentID = getID(info?.parentID)
    const record = getSessionRecord(sessionID)
    record.known = true
    record.isChild = parentID !== undefined
    record.parentID = parentID
    if (typeof info?.title === "string") record.title = info.title
    record.deleted = false
    record.errored = false
    record.idleHandled = false

    // Creation records the relationship only. It must not itself make a
    // child appear active. Preserve activity if a status was already observed.
    if (!record.isChild) record.active = false
    updateSubagentVisibility()
  }

  function reduceTaskPartUpdated(part: any): void {
    if (part?.type !== "tool" || part.tool !== "task") return

    const sessionID = getID(part.sessionID)
    const messageID = getID(part.messageID)
    const partID = getID(part.id)
    if (!sessionID || !messageID || !partID) return

    const session = sessionRecords.get(sessionID)
    if (session?.deleted || session?.errored) return

    const status = part.state?.status
    if (status === "running") {
      let messages = activeTaskParts.get(sessionID)
      if (!messages) {
        messages = new Map()
        activeTaskParts.set(sessionID, messages)
      }

      let partIDs = messages.get(messageID)
      if (!partIDs) {
        partIDs = new Set()
        messages.set(messageID, partIDs)
      }

      if (!partIDs.has(partID)) {
        partIDs.add(partID)
        updateSubagentVisibility()
      }
      return
    }

    if (status !== "completed" && status !== "error") return

    const messages = activeTaskParts.get(sessionID)
    const partIDs = messages?.get(messageID)
    if (!partIDs?.delete(partID)) return

    if (partIDs.size === 0) messages?.delete(messageID)
    if (messages?.size === 0) activeTaskParts.delete(sessionID)
    updateSubagentVisibility()
  }

  function reduceTaskPartRemoved(properties: any): void {
    const sessionID = getID(properties?.sessionID)
    const messageID = getID(properties?.messageID)
    const partID = getID(properties?.partID)
    if (!sessionID || !messageID || !partID) return

    const messages = activeTaskParts.get(sessionID)
    const partIDs = messages?.get(messageID)
    if (!partIDs?.delete(partID)) return

    if (partIDs.size === 0) messages?.delete(messageID)
    if (messages?.size === 0) activeTaskParts.delete(sessionID)
    updateSubagentVisibility()
  }

  function reduceMessageRemoved(properties: any): void {
    const sessionID = getID(properties?.sessionID)
    const messageID = getID(properties?.messageID)
    if (!sessionID || !messageID) return

    const messages = activeTaskParts.get(sessionID)
    if (!messages?.delete(messageID)) return
    if (messages.size === 0) activeTaskParts.delete(sessionID)
    updateSubagentVisibility()
  }

  function reduceSessionActivityCleanup(sessionID: string, deleted: boolean): void {
    const record = getSessionRecord(sessionID)
    record.active = false
    record.latestStatus = undefined
    record.errored = true
    record.deleted = deleted
    record.idleHandled = false
    activeTaskParts.delete(sessionID)
    updateSubagentVisibility()
    if (deleted) evictDeletedSessionRecord(sessionID, record)
  }

  function reduceSessionStatus(
    sessionID: string | undefined,
    status: unknown,
  ): Promise<void> | boolean | undefined {
    if (!sessionID) return undefined
    const record = getSessionRecord(sessionID)
    if (record.deleted) return status === "idle" ? false : undefined

    if (status === "busy" || status === "retry") {
      record.latestStatus = status
      record.errored = false
      record.idleHandled = false

      if (record.known) {
        if (record.isChild && !record.active) {
          record.active = true
          updateSubagentVisibility()
        }
        return undefined
      }

      return ensureChildLookup(sessionID)
    }

    if (status === "idle") {
      record.latestStatus = "idle"
      record.errored = false
      if (record.isChild) {
        record.active = false
        updateSubagentVisibility()
      }

      if (record.idleHandled) return false
      record.idleHandled = true
      return true
    }

    return undefined
  }

  function reduceSessionDeletedOrErrored(
    sessionID: string | undefined,
    deleted: boolean,
  ): void {
    if (!sessionID) return
    reduceSessionActivityCleanup(sessionID, deleted)
  }

  function cacheSessionDetails(
    sessionID: string,
    details: { title: string; parentID?: string },
  ): SessionRecord {
    const record = getSessionRecord(sessionID)
    if (typeof details.title === "string") record.title = details.title

    // An explicit session.created relationship is authoritative. Otherwise,
    // cache the relationship returned by session.get for later idle handling.
    if (!record.known) {
      record.known = true
      record.parentID = getID(details.parentID)
      record.isChild = record.parentID !== undefined
    }
    return record
  }

  function getCachedSessionDetails(
    sessionID: string,
  ): { title: string; parentID?: string } | null {
    const record = sessionRecords.get(sessionID)
    if (!record?.known) return null
    return {
      title: record.title ?? sessionID,
      parentID: record.isChild ? record.parentID : undefined,
    }
  }

  function evictDeletedSessionRecord(
    sessionID: string,
    record: SessionRecord,
  ): void {
    if (
      sessionRecords.get(sessionID) !== record ||
      !record.deleted ||
      sessionLookups.has(sessionID) ||
      childLookups.has(sessionID)
    ) {
      return
    }
    sessionRecords.delete(sessionID)
  }

  // Rightmost surface in each of the 3 rows (top-right, bottom-right, bottom-left)
  // Used as split targets when adding new columns
  const rowFrontier: (string | undefined)[] = [undefined, undefined, undefined]
  let agentCount = 0

  let splitQueue = Promise.resolve<unknown>(undefined)
  function enqueueSplitOp<T>(fn: () => Promise<T>): Promise<T> {
    const result = splitQueue.then(fn, fn)
    splitQueue = result.then(
      () => {},
      () => {},
    )
    return result as Promise<T>
  }

  function resetGridState(): void {
    rowFrontier[0] = undefined
    rowFrontier[1] = undefined
    rowFrontier[2] = undefined
    agentCount = 0
  }

  function removeAndClose(sessionId: string): void {
    const surfaceId = activeSplits.get(sessionId)
    if (!surfaceId) return
    activeSplits.delete(sessionId)
    closeSurface($, surfaceId).catch(() => {})
    if (activeSplits.size === 0) {
      resetGridState()
    }
  }

  function isWaitingForInput(): boolean {
    return pendingPermissions.size > 0 || pendingQuestions.size > 0
  }

  function getPermissionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID ?? source.permissionID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  function getQuestionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  async function fetchSession(
    sessionID: string,
  ): Promise<{ title: string; parentID?: string } | null> {
    try {
      const result = await client.session.get({ path: { id: sessionID } })
      if (result.data) {
        return { title: result.data.title, parentID: result.data.parentID }
      }
      return null
    } catch {
      return null
    }
  }

  function fetchSessionOnce(
    sessionID: string,
  ): Promise<{ title: string; parentID?: string } | null> {
    const existing = sessionLookups.get(sessionID)
    if (existing) return existing

    const lookup = fetchSession(sessionID)
    const record = sessionRecords.get(sessionID)
    sessionLookups.set(sessionID, lookup)
    void lookup.then(
      () => {
        if (sessionLookups.get(sessionID) === lookup) sessionLookups.delete(sessionID)
        if (record) evictDeletedSessionRecord(sessionID, record)
      },
      () => {
        if (sessionLookups.get(sessionID) === lookup) sessionLookups.delete(sessionID)
        if (record) evictDeletedSessionRecord(sessionID, record)
      },
    )
    return lookup
  }

  function ensureChildLookup(sessionID: string): Promise<void> {
    const existing = childLookups.get(sessionID)
    if (existing) return existing

    const lookupRecord = sessionRecords.get(sessionID)
    const lookup = (async () => {
      const details = await fetchSessionOnce(sessionID)
      if (!details) return

      const record = sessionRecords.get(sessionID)
      if (!record || record.deleted || record.errored) return
      const wasKnown = record.known
      const returnedParentID = getID(details.parentID)
      cacheSessionDetails(sessionID, details)

      // A lookup may finish after idle, error, or deletion. Only the current
      // busy/retry state can activate a child, and a deleted session is never
      // resurrected by a stale response.
      if (
        !isActiveSessionStatus(record.latestStatus) ||
        returnedParentID === undefined
      ) {
        return
      }

      // A session.created event that identified this as a root wins over an
      // out-of-date lookup result.
      if (wasKnown && !record.isChild) return

      record.known = true
      record.isChild = true
      record.parentID = returnedParentID
      if (!record.active) {
        record.active = true
        updateSubagentVisibility()
      }
    })()

    childLookups.set(sessionID, lookup)
    void lookup.then(
      () => {
        if (childLookups.get(sessionID) === lookup) childLookups.delete(sessionID)
        if (lookupRecord) evictDeletedSessionRecord(sessionID, lookupRecord)
      },
      () => {
        if (childLookups.get(sessionID) === lookup) childLookups.delete(sessionID)
        if (lookupRecord) evictDeletedSessionRecord(sessionID, lookupRecord)
      },
    )
    return lookup
  }

  async function handleSessionIdle(
    sessionID: string,
    waitingAtEvent: boolean,
  ): Promise<void> {
    if (waitingAtEvent) return

    let session = getCachedSessionDetails(sessionID)
    if (!session) {
      session = await fetchSessionOnce(sessionID)
      const record = sessionRecords.get(sessionID)
      if (!record || record.deleted || record.errored) return
      if (session) cacheSessionDetails(sessionID, session)
    }

    const record = sessionRecords.get(sessionID)
    if (!record || record.deleted || record.errored) return
    const title = session?.title ?? record?.title ?? sessionID
    const isChild = record?.known ? record.isChild : session?.parentID !== undefined

    // Preserve the existing child completion log and split cleanup.
    if (isChild) {
      await log($, `Subagent finished: ${title}`, {
        level: "info",
        source: "opencode",
      })
      removeAndClose(sessionID)
      return
    }

    if (notifyOn.done) await notify($, { title: `Done: ${title}` })
    await log($, `Done: ${title}`, { level: "success", source: "opencode" })
    await clearStatus($, "opencode")
  }

  return {
    async event({ event }) {
      const e = event as any

      if (e.type === "session.created") {
        const info = e.properties.info
        reduceSessionCreated(info)
        if (splitsEnabled && info?.parentID) {
          const url = resolveServerUrl()
          if (url) {
            await enqueueSplitOp(async () => {
              if (activeSplits.has(info.id)) return

              let direction: SplitDirection
              let fromSurface: string | undefined
              const n = agentCount

              if (n === 0) {
                direction = "right"
                fromSurface = originalSurfaceId
              } else if (n === 1) {
                direction = "down"
                fromSurface = rowFrontier[0]
              } else if (n === 2) {
                direction = "down"
                fromSurface = originalSurfaceId
              } else {
                const rowIdx = (n - 3) % 3
                direction = "right"
                fromSurface = rowFrontier[rowIdx]
              }

              const surfaceId = await createSplit($, direction, fromSurface)
              if (!surfaceId) return

              if (n < 3) {
                rowFrontier[n] = surfaceId
              } else {
                const rowIdx = (n - 3) % 3
                rowFrontier[rowIdx] = surfaceId
              }

              activeSplits.set(info.id, surfaceId)
              agentCount++

              const attachCmd = `opencode attach ${url} --session ${info.id}`
              await sendToSurface($, surfaceId, attachCmd)
              await sendKeyToSurface($, surfaceId, "enter")

              if (originalSurfaceId) {
                await focusSurface($, originalSurfaceId)
              }
            })
          }
        }
        return
      }

      if (e.type === "session.deleted") {
        const info = e.properties.info
        const sessionID = getID(info?.id)
        reduceSessionDeletedOrErrored(sessionID, true)
        if (sessionID) removeAndClose(sessionID)
        return
      }

      if (e.type === "message.part.updated") {
        reduceTaskPartUpdated(e.properties?.part)
        return
      }

      if (e.type === "message.part.removed") {
        reduceTaskPartRemoved(e.properties)
        return
      }

      if (e.type === "message.removed") {
        reduceMessageRemoved(e.properties)
        return
      }

      if (e.type === "session.status") {
        const { sessionID, status } = e.properties ?? {}
        const childLookup = reduceSessionStatus(sessionID, status?.type)

        if (status?.type === "busy") {
          if (!isWaitingForInput()) {
            await setStatus($, "opencode", "working", {
              icon: "terminal",
              color: "#f59e0b",
            })
          }
          if (childLookup && typeof childLookup !== "boolean") await childLookup
          return
        }

        if (status?.type === "retry") {
          if (childLookup && typeof childLookup !== "boolean") await childLookup
          return
        }

        if (status?.type === "idle") {
          if (sessionID && childLookup !== false) {
            await handleSessionIdle(sessionID, isWaitingForInput())
          }
          return
        }
      }

      if (e.type === "session.idle") {
        const sessionID = getID(e.properties?.sessionID)
        const childLookup = reduceSessionStatus(sessionID, "idle")
        if (childLookup && typeof childLookup !== "boolean") await childLookup
        if (sessionID && childLookup !== false) {
          await handleSessionIdle(sessionID, isWaitingForInput())
        }
        return
      }

      if (e.type === "session.error") {
        const sessionID = getID(e.properties?.sessionID)
        reduceSessionDeletedOrErrored(sessionID, false)

        pendingPermissions.clear()
        pendingQuestions.clear()

        const title = sessionID
          ? (getCachedSessionDetails(sessionID)?.title ??
            (await fetchSessionOnce(sessionID))?.title ??
            sessionID)
          : "unknown session"

        if (notifyOn.error) await notify($, { title: `Error: ${title}` })
        await log($, `Error in session: ${title}`, {
          level: "error",
          source: "opencode",
        })
        await clearStatus($, "opencode")

        if (sessionID) removeAndClose(sessionID)
        return
      }

      if (e.type === "permission.asked" || e.type === "permission.updated") {
        const id = getPermissionRequestID(e.properties)
        if (id && !pendingPermissions.has(id)) {
          pendingPermissions.add(id)
          const title = e.properties.title ?? e.properties.permission ?? "command"
          await setStatus($, "opencode", "waiting", {
            icon: "lock",
            color: "#ef4444",
          })
          if (notifyOn.permission)
            await notify($, { title: "Needs your permission", subtitle: title })
          await log($, `Permission requested: ${title}`, {
            level: "info",
            source: "opencode",
          })
        }
        return
      }

      if (e.type === "permission.replied") {
        const id = getPermissionRequestID(e.properties)
        if (id) {
          pendingPermissions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setStatus($, "opencode", "working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        }
        return
      }

      if (e.type === "question.asked") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.add(id)
        }

        const header = e.properties.questions?.[0]?.header ?? "Question"
        await setStatus($, "opencode", "question", {
          icon: "help-circle",
          color: "#a855f7",
        })
        if (notifyOn.question)
          await notify($, { title: "Has a question", subtitle: header })
        await log($, `Question: ${header}`, { level: "info", source: "opencode" })
        return
      }

      if (e.type === "question.replied" || e.type === "question.rejected") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setStatus($, "opencode", "working", {
            icon: "terminal",
            color: "#f59e0b",
          })
        }
        return
      }
    },

    async "permission.ask"(input) {
      const id = getPermissionRequestID(input as any)
      if (id) {
        pendingPermissions.add(id)
      }

      const title = (input as any).title ?? (input as any).permission ?? "command"
      await setStatus($, "opencode", "waiting", {
        icon: "lock",
        color: "#ef4444",
      })
      if (notifyOn.permission)
        await notify($, { title: "Needs your permission", subtitle: title })
      await log($, `Permission requested: ${title}`, {
        level: "info",
        source: "opencode",
      })
    },
  }
}

export default plugin
