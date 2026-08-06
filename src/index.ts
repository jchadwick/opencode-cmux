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
  const pendingPermissions = new Map<string, string | undefined>()
  const pendingQuestions = new Map<string, string | undefined>()
  const permissionAnnouncements = new Map<string, string | undefined>()

  const originalSurfaceId = process.env.CMUX_SURFACE_ID
  const surfaceID = originalSurfaceId?.trim()
  const indicatorStatusKey = surfaceID
    ? `opencode-subagents:${surfaceID}`
    : `opencode-subagents:pid:${process.pid}`

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
    latestStatus?: SessionActivityStatus
    activityGeneration: number
    deleted: boolean
    errored: boolean
    idleHandled: boolean
  }

  type IndicatorState = "idle" | "running" | "needs-input"
  type IdleReduction = { record: SessionRecord; generation: number }
  const IDLE_STABILITY_MS = 250

  const activeTaskParts = new Map<string, Map<string, Set<string>>>()
  const sessionRecords = new Map<string, SessionRecord>()
  const deletedSessionIDs = new Set<string>()
  const sessionLookups = new Map<string, Promise<{ title: string; parentID?: string } | null>>()
  const childLookups = new Map<string, Promise<void>>()

  const MAX_PERMISSION_ANNOUNCEMENTS = 1024
  let observedState: IndicatorState = "idle"
  let renderTarget: IndicatorState | undefined
  let lastAttemptedState: IndicatorState | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimerGeneration = 0
  let renderQueued = false
  const indicatorStatusQueue: Array<() => Promise<void>> = []
  let indicatorStatusBusy = false

  function hasActiveTaskParts(): boolean {
    for (const messages of activeTaskParts.values()) {
      for (const partIDs of messages.values()) {
        if (partIDs.size > 0) return true
      }
    }
    return false
  }

  function hasActiveSessions(): boolean {
    for (const session of sessionRecords.values()) {
      if (
        isActiveSessionStatus(session.latestStatus) &&
        !session.deleted &&
        !session.errored
      ) {
        return true
      }
    }
    return false
  }

  function hasPendingInput(): boolean {
    return pendingPermissions.size > 0 || pendingQuestions.size > 0
  }

  function enqueueIndicatorOperation(operation: () => Promise<void>): void {
    indicatorStatusQueue.push(operation)
    drainIndicatorQueue()
  }

  function drainIndicatorQueue(): void {
    if (indicatorStatusBusy) return
    const operation = indicatorStatusQueue.shift()
    if (!operation) return

    indicatorStatusBusy = true
    void operation()
      .catch(() => {})
      .finally(() => {
        indicatorStatusBusy = false
        drainIndicatorQueue()
      })
  }

  function getIndicatorStatus(state: IndicatorState): {
    text: string
    icon: string
    color: string
  } {
    return state === "idle"
      ? { text: "Idle", icon: "pause.circle.fill", color: "#8E8E93" }
      : state === "running"
        ? { text: "Running", icon: "bolt.fill", color: "#4C8DFF" }
        : { text: "Needs input", icon: "bell.fill", color: "#4C8DFF" }
  }

  function enqueueIndicatorRender(): void {
    if (renderQueued) return
    renderQueued = true
    enqueueIndicatorOperation(async () => {
      renderQueued = false
      const target = renderTarget
      if (target === undefined || target === lastAttemptedState) return

      const status = getIndicatorStatus(target)
      try {
        await setStatus($, indicatorStatusKey, status.text, {
          icon: status.icon,
          color: status.color,
        })
      } finally {
        lastAttemptedState = target
        if (renderTarget !== target) enqueueIndicatorRender()
      }
    })
  }

  function invalidateIdleTimer(): void {
    idleTimerGeneration++
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  function scheduleIdleRender(): void {
    if (idleTimer !== undefined) return
    const generation = ++idleTimerGeneration
    let timer: ReturnType<typeof setTimeout>
    timer = setTimeout(() => {
      if (idleTimer !== timer) return
      idleTimer = undefined
      if (generation !== idleTimerGeneration || observedState !== "idle") return
      renderTarget = "idle"
      enqueueIndicatorRender()
    }, IDLE_STABILITY_MS)
    idleTimer = timer
  }

  function enqueueIndicatorState(state: IndicatorState): void {
    if (state === observedState) {
      if (state !== "idle" && renderTarget !== state) {
        renderTarget = state
        enqueueIndicatorRender()
      }
      return
    }

    observedState = state
    if (state === "idle") {
      // Idle is deliberately observed immediately, but is only eligible for
      // rendering after it has remained current for the stability window.
      scheduleIdleRender()
      return
    }

    invalidateIdleTimer()
    renderTarget = state
    enqueueIndicatorRender()
  }

  function updateIndicatorState(): void {
    const state: IndicatorState = hasPendingInput()
      ? "needs-input"
      : hasActiveTaskParts() || hasActiveSessions()
        ? "running"
        : "idle"
    enqueueIndicatorState(state)
  }

  // Migrate the old generic indicator before publishing the persistent
  // dedicated indicator. Both operations share the same non-poisoning FIFO.
  enqueueIndicatorOperation(() => clearStatus($, "opencode"))
  enqueueIndicatorOperation(() => clearStatus($, "opencode-subagents"))
  scheduleIdleRender()

  function getID(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const trimmed = value.trim()
    return trimmed === "" ? undefined : trimmed
  }

  function getSessionRecord(sessionID: string): SessionRecord {
    const existing = sessionRecords.get(sessionID)
    if (existing) return existing

    const record: SessionRecord = {
      known: false,
      isChild: false,
      activityGeneration: 0,
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

  function isIdleReduction(
    reduction: Promise<void> | IdleReduction | false | undefined,
  ): reduction is IdleReduction {
    return typeof reduction === "object" && reduction !== null && "record" in reduction
  }

  function reduceSessionCreated(info: any): void {
    const sessionID = getID(info?.id)
    if (!sessionID || deletedSessionIDs.has(sessionID)) return

    const parentID = getID(info?.parentID)
    const existing = sessionRecords.get(sessionID)
    const record = existing ?? getSessionRecord(sessionID)
    record.known = true
    record.isChild = parentID !== undefined
    record.parentID = parentID
    if (typeof info?.title === "string") record.title = info.title

    // Creation records classification only. Do not activate the session or
    // reset lifecycle state that arrived before session.created.
  }

  function reduceTaskPartUpdated(part: any): void {
    if (part?.type !== "tool" || part.tool !== "task") return

    const sessionID = getID(part.sessionID)
    const messageID = getID(part.messageID)
    const partID = getID(part.id)
    if (!sessionID || !messageID || !partID) return

    const session = sessionRecords.get(sessionID)
    if (deletedSessionIDs.has(sessionID) || session?.deleted || session?.errored) return

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
        updateIndicatorState()
      }
      return
    }

    if (status !== "completed" && status !== "error") return

    const messages = activeTaskParts.get(sessionID)
    const partIDs = messages?.get(messageID)
    if (!partIDs?.delete(partID)) return

    if (partIDs.size === 0) messages?.delete(messageID)
    if (messages?.size === 0) activeTaskParts.delete(sessionID)
    updateIndicatorState()
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
    updateIndicatorState()
  }

  function reduceMessageRemoved(properties: any): void {
    const sessionID = getID(properties?.sessionID)
    const messageID = getID(properties?.messageID)
    if (!sessionID || !messageID) return

    const messages = activeTaskParts.get(sessionID)
    if (!messages?.delete(messageID)) return
    if (messages.size === 0) activeTaskParts.delete(sessionID)
    updateIndicatorState()
  }

  function reduceSessionActivityCleanup(sessionID: string, deleted: boolean): void {
    if (deletedSessionIDs.has(sessionID)) return
    if (deleted) deletedSessionIDs.add(sessionID)

    const record = getSessionRecord(sessionID)
    record.latestStatus = undefined
    record.activityGeneration++
    record.errored = true
    record.deleted = deleted
    record.idleHandled = false
    removeOwnedRequests(sessionID)
    activeTaskParts.delete(sessionID)
    updateIndicatorState()
    if (deleted) evictDeletedSessionRecord(sessionID, record)
  }

  function reduceSessionStatus(
    sessionID: string | undefined,
    status: unknown,
  ): Promise<void> | IdleReduction | false | undefined {
    if (!sessionID) return undefined
    if (deletedSessionIDs.has(sessionID)) return status === "idle" ? false : undefined
    const record = getSessionRecord(sessionID)
    if (record.deleted) return status === "idle" ? false : undefined

    if (status === "busy" || status === "retry") {
      record.latestStatus = status
      record.activityGeneration++
      record.errored = false
      record.idleHandled = false
      updateIndicatorState()

      return record.known ? undefined : ensureChildLookup(sessionID)
    }

    if (status === "idle") {
      record.latestStatus = "idle"
      record.errored = false
      updateIndicatorState()

      if (record.idleHandled) return false
      record.activityGeneration++
      record.idleHandled = true
      return { record, generation: record.activityGeneration }
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
  ): void {
    if (deletedSessionIDs.has(sessionID)) return
    const record = getSessionRecord(sessionID)
    if (typeof details.title === "string") record.title = details.title

    // An explicit session.created relationship is authoritative. Otherwise,
    // cache the relationship returned by session.get for later idle handling.
    if (!record.known) {
      record.known = true
      record.parentID = getID(details.parentID)
      record.isChild = record.parentID !== undefined
    }
  }

  function getCachedSessionDetails(
    sessionID: string,
  ): { title: string; parentID?: string } | null {
    if (deletedSessionIDs.has(sessionID)) return null
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

  function isTerminalSession(sessionID: string): boolean {
    if (deletedSessionIDs.has(sessionID)) return true
    const record = sessionRecords.get(sessionID)
    return (
      !record ||
      record.deleted ||
      record.errored ||
      record.latestStatus === "idle"
    )
  }

  function isWaitingForInput(): boolean {
    return hasPendingInput()
  }

  function getAskedRequestID(source: any): string | undefined {
    return getID(source?.id)
  }

  function getPermissionReplyRequestID(source: any): string | undefined {
    return getID(source?.requestID ?? source?.permissionID)
  }

  function getQuestionReplyRequestID(source: any): string | undefined {
    return getID(source?.requestID)
  }

  function getPermissionLabel(source: any): string {
    return source?.title ?? source?.permission ?? source?.action ?? "command"
  }

  function getPermissionAnnouncementID(source: any): string | undefined {
    if (!source) return undefined
    return getID(source.id ?? source.requestID ?? source.permissionID)
  }

  function getSessionOwner(source: any): string | undefined {
    return getID(source?.sessionID)
  }

  function isDeletedOwner(sessionID: string | undefined): boolean {
    return sessionID !== undefined && deletedSessionIDs.has(sessionID)
  }

  function removeOwnedRequests(sessionID: string): void {
    for (const [requestID, owner] of pendingPermissions) {
      if (owner === sessionID) pendingPermissions.delete(requestID)
    }
    for (const [requestID, owner] of pendingQuestions) {
      if (owner === sessionID) pendingQuestions.delete(requestID)
    }
    for (const [requestID, owner] of permissionAnnouncements) {
      if (owner === sessionID) permissionAnnouncements.delete(requestID)
    }
  }

  function rememberPermissionAnnouncement(
    requestID: string,
    sessionID: string | undefined,
  ): boolean {
    if (permissionAnnouncements.has(requestID)) return false
    permissionAnnouncements.set(requestID, sessionID)

    if (permissionAnnouncements.size > MAX_PERMISSION_ANNOUNCEMENTS) {
      const oldest = permissionAnnouncements.keys().next().value
      if (typeof oldest === "string") permissionAnnouncements.delete(oldest)
    }
    return true
  }

  async function announcePermission(
    requestID: string | undefined,
    sessionID: string | undefined,
    title: string,
  ): Promise<void> {
    if (isDeletedOwner(sessionID)) return
    if (requestID !== undefined && !rememberPermissionAnnouncement(requestID, sessionID)) {
      return
    }
    if (notifyOn.permission)
      await notify($, { title: "Needs your permission", subtitle: title })
    await log($, `Permission requested: ${title}`, {
      level: "info",
      source: "opencode",
    })
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

      if (deletedSessionIDs.has(sessionID)) return
      const record = sessionRecords.get(sessionID)
      if (!record || record.deleted || record.errored) return
      cacheSessionDetails(sessionID, details)
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

  function isCurrentIdleSession(
    sessionID: string,
    record: SessionRecord,
    generation: number,
  ): boolean {
    return (
      sessionRecords.get(sessionID) === record &&
      !deletedSessionIDs.has(sessionID) &&
      !record.deleted &&
      !record.errored &&
      record.activityGeneration === generation &&
      record.latestStatus === "idle"
    )
  }

  async function handleSessionIdle(
    sessionID: string,
    waitingAtEvent: boolean,
    expectedRecord: SessionRecord,
    expectedGeneration: number,
  ): Promise<void> {
    if (waitingAtEvent) return
    if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return

    let session = getCachedSessionDetails(sessionID)
    if (!session) {
      session = await fetchSessionOnce(sessionID)
      if (deletedSessionIDs.has(sessionID)) return
      const record = sessionRecords.get(sessionID)
      if (!record || record.deleted || record.errored) return
      if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
      if (session) cacheSessionDetails(sessionID, session)
    }

    if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
    const title = session?.title ?? expectedRecord.title ?? sessionID
    const isChild = expectedRecord.known
      ? expectedRecord.isChild
      : session?.parentID !== undefined

    // Preserve the existing child completion log and split cleanup.
    if (isChild) {
      if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
      await log($, `Subagent finished: ${title}`, {
        level: "info",
        source: "opencode",
      })
      if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
      removeAndClose(sessionID)
      return
    }

    if (notifyOn.done) {
      if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
      await notify($, { title: `Done: ${title}` })
    }
    if (!isCurrentIdleSession(sessionID, expectedRecord, expectedGeneration)) return
    await log($, `Done: ${title}`, { level: "success", source: "opencode" })
  }

  return {
    async event({ event }) {
      const e = event as any

      if (e.type === "session.created") {
        const info = e.properties.info
        const sessionID = getID(info?.id)
        if (!sessionID || deletedSessionIDs.has(sessionID)) return
        reduceSessionCreated(info)
        if (splitsEnabled && info?.parentID) {
          const url = resolveServerUrl()
          if (url) {
            await enqueueSplitOp(async () => {
              if (isTerminalSession(sessionID) || activeSplits.has(sessionID)) return

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
              if (isTerminalSession(sessionID)) {
                await closeSurface($, surfaceId)
                return
              }

              if (n < 3) {
                rowFrontier[n] = surfaceId
              } else {
                const rowIdx = (n - 3) % 3
                rowFrontier[rowIdx] = surfaceId
              }

              activeSplits.set(sessionID, surfaceId)
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
        const sessionID = getID(info?.id ?? e.properties?.sessionID)
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

        if (status?.type === "busy" || status?.type === "retry") {
          if (childLookup instanceof Promise) await childLookup
          return
        }

        if (status?.type === "idle") {
          if (sessionID && isIdleReduction(childLookup)) {
            await handleSessionIdle(
              sessionID,
              isWaitingForInput(),
              childLookup.record,
              childLookup.generation,
            )
          }
          return
        }
      }

      if (e.type === "session.idle") {
        const sessionID = getID(e.properties?.sessionID)
        const childLookup = reduceSessionStatus(sessionID, "idle")
        if (sessionID && isIdleReduction(childLookup)) {
          await handleSessionIdle(
            sessionID,
            isWaitingForInput(),
            childLookup.record,
            childLookup.generation,
          )
        }
        return
      }

      if (e.type === "session.error") {
        const sessionID = getID(e.properties?.sessionID)
        reduceSessionDeletedOrErrored(sessionID, false)

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

        if (sessionID) removeAndClose(sessionID)
        return
      }

      if (
        e.type === "permission.asked" ||
        e.type === "permission.v2.asked" ||
        e.type === "permission.updated"
      ) {
        const id = getAskedRequestID(e.properties)
        const sessionID = getSessionOwner(e.properties)
        if (id && !isDeletedOwner(sessionID)) {
          pendingPermissions.set(id, sessionID)
          updateIndicatorState()
          const title = getPermissionLabel(e.properties)
          await announcePermission(id, sessionID, title)
        }
        return
      }

      if (e.type === "permission.replied" || e.type === "permission.v2.replied") {
        const id = getPermissionReplyRequestID(e.properties)
        if (id) {
          pendingPermissions.delete(id)
          permissionAnnouncements.delete(id)
          updateIndicatorState()
        }
        return
      }

      if (e.type === "question.asked" || e.type === "question.v2.asked") {
        const id = getAskedRequestID(e.properties)
        const sessionID = getSessionOwner(e.properties)
        if (id && !isDeletedOwner(sessionID)) {
          pendingQuestions.set(id, sessionID)
          updateIndicatorState()
          const header = e.properties.questions?.[0]?.header ?? "Question"
          if (notifyOn.question)
            await notify($, { title: "Has a question", subtitle: header })
          await log($, `Question: ${header}`, { level: "info", source: "opencode" })
        }
        return
      }

      if (
        e.type === "question.replied" ||
        e.type === "question.rejected" ||
        e.type === "question.v2.replied" ||
        e.type === "question.v2.rejected"
      ) {
        const id = getQuestionReplyRequestID(e.properties)
        if (id) {
          pendingQuestions.delete(id)
          updateIndicatorState()
        }
        return
      }
    },

    async "permission.ask"(input) {
      const title = getPermissionLabel(input as any)
      await announcePermission(
        getPermissionAnnouncementID(input as any),
        getSessionOwner(input as any),
        title,
      )
    },
  }
}

export default plugin
