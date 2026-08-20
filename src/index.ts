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

type SessionState = "busy" | "retry" | "idle" | "error"
type IndicatorState = "idle" | "running" | "needs-input"
type ParentID = string | null | undefined
type PendingMap = Map<string, string | undefined>
interface SessionRecord {
  parentID: ParentID
  title?: string
  status?: SessionState
  generation: number
  idleHandled: boolean
}
interface SessionDetails {
  title?: string
  parentID: string | null
}

const IDLE_MS = 250
const MAX_TOMBSTONES = 1024
const MAX_ANNOUNCEMENTS = 1024
const PERMISSION_ASKED = new Set([
  "permission.asked",
  "permission.v2.asked",
  "permission.updated",
])
const PERMISSION_REPLIED = new Set(["permission.replied", "permission.v2.replied"])
const QUESTION_ASKED = new Set(["question.asked", "question.v2.asked"])
const QUESTION_REPLIED = new Set([
  "question.replied",
  "question.rejected",
  "question.v2.replied",
  "question.v2.rejected",
])
const INDICATOR_STYLES = {
  idle: { text: "Idle", icon: "pause.circle.fill", color: "#8E8E93" },
  running: { text: "Running", icon: "bolt.fill", color: "#4C8DFF" },
  "needs-input": { text: "Needs input", icon: "bell.fill", color: "#4C8DFF" },
} as const

const plugin: Plugin = async ({ client, $, directory }) => {
  const pendingPermissions: PendingMap = new Map()
  const pendingQuestions: PendingMap = new Map()
  const permissionAnnouncements: PendingMap = new Map()
  const sessionRecords = new Map<string, SessionRecord>()
  const sessionLookups = new Map<string, Promise<SessionDetails | null>>()
  const deletedSessionIDs = new Set<string>()
  const activeTaskParts = new Map<string, { sessionID: string; messageID: string }>()
  const activeSplits = new Map<string, string>()
  const rowFrontier: (string | undefined)[] = [undefined, undefined, undefined]
  const originalSurfaceId = process.env.CMUX_SURFACE_ID
  const surfaceId = originalSurfaceId?.trim()
  const indicatorStatusKey = surfaceId
    ? `opencode-subagents:${surfaceId}`
    : `opencode-subagents:pid:${process.pid}`

  let splitsEnabled = false
  const notifyOn = { done: true, permission: true, question: true, error: true }
  try {
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
    const configPath = join(configDir, "opencode", "opencode-cmux.json")
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
    splitsEnabled = config.splits === true
    if (config.notifications !== undefined) {
      if (
        typeof config.notifications === "object" &&
        config.notifications !== null &&
        !Array.isArray(config.notifications)
      ) {
        const notifications = config.notifications as Record<string, unknown>
        for (const key of ["done", "permission", "question", "error"] as const) {
          const value = notifications[key]
          if (value === undefined) continue
          if (typeof value === "boolean") notifyOn[key] = value
          else {
            console.warn(
              `[opencode-cmux] config.notifications.${key} ignored: expected boolean, got ${typeof value}`,
            )
          }
        }
      } else {
        const got = Array.isArray(config.notifications) ? "array" : typeof config.notifications
        console.warn(
          `[opencode-cmux] config.notifications ignored: expected object, got ${got}`,
        )
      }
    }
  } catch {}

  let discoveredServerUrl: string | null | undefined
  function resolveServerUrl(): string | null {
    if (discoveredServerUrl !== undefined) return discoveredServerUrl
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
    try {
      const output = execSync(
        `lsof -nP -a -p ${process.pid} -iTCP -sTCP:LISTEN 2>/dev/null`,
        { encoding: "utf-8", timeout: 3000 },
      )
      for (const line of output.split("\n")) {
        const match = line.match(LSOF_LISTEN_RE)
        if (match) return (discoveredServerUrl = `http://localhost:${match[1]}`)
      }
    } catch {}
    return (discoveredServerUrl = null)
  }

  let agentCount = 0
  let splitQueue = Promise.resolve()
  function enqueueSplit(fn: () => Promise<void>): void {
    const operation = splitQueue.then(fn, fn)
    splitQueue = operation.then(
      () => undefined,
      () => undefined,
    )
  }

  const statusQueue: (() => Promise<void>)[] = []
  let statusBusy = false
  function enqueueStatus(fn: () => Promise<void>): void {
    statusQueue.push(fn)
    drainStatus()
  }
  function drainStatus(): void {
    if (statusBusy) return
    const fn = statusQueue.shift()
    if (!fn) return
    statusBusy = true
    const done = () => {
      statusBusy = false
      drainStatus()
    }
    try {
      Promise.resolve(fn()).catch(() => undefined).then(done)
    } catch {
      done()
    }
  }

  function resetGrid(): void {
    rowFrontier[0] = undefined
    rowFrontier[1] = undefined
    rowFrontier[2] = undefined
    agentCount = 0
  }
  function removeAndClose(sessionID: string): void {
    const splitID = activeSplits.get(sessionID)
    if (!splitID) return
    activeSplits.delete(sessionID)
    closeSurface($, splitID).catch(() => {})
    if (activeSplits.size === 0) resetGrid()
  }
  function closeAllSplits(): void {
    const splitIDs = [...activeSplits.values()]
    activeSplits.clear()
    resetGrid()
    for (const splitID of splitIDs) closeSurface($, splitID).catch(() => {})
  }

  function getID(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const id = value.trim()
    return id || undefined
  }
  function firstID(...values: unknown[]): string | undefined {
    for (const value of values) {
      const id = getID(value)
      if (id) return id
    }
    return undefined
  }
  const ownerOf = (source: any): string | undefined => getID(source?.sessionID)
  const askedID = (source: any) =>
    firstID(source?.id, source?.requestID, source?.permissionID)
  const permissionReplyID = (source: any) =>
    firstID(source?.requestID, source?.permissionID, source?.id)
  const questionReplyID = (source: any) => firstID(source?.requestID, source?.id)
  const permissionLabel = (source: any): string =>
    source?.title ?? source?.permission ?? source?.action ?? "command"

  function addTombstone(sessionID: string): void {
    if (deletedSessionIDs.has(sessionID)) return
    deletedSessionIDs.add(sessionID)
    while (deletedSessionIDs.size > MAX_TOMBSTONES) {
      deletedSessionIDs.delete(deletedSessionIDs.values().next().value as string)
    }
  }
  function recordFor(sessionID: string): SessionRecord {
    let record = sessionRecords.get(sessionID)
    if (!record) {
      record = { parentID: undefined, generation: 0, idleHandled: false }
      sessionRecords.set(sessionID, record)
    }
    return record
  }
  function recordSession(info: any): string | undefined {
    const sessionID = getID(info?.id)
    if (!sessionID || deletedSessionIDs.has(sessionID)) return undefined
    const record = recordFor(sessionID)
    record.parentID = getID(info?.parentID) ?? null
    if (typeof info?.title === "string") record.title = info.title
    return sessionID
  }
  function cacheDetails(sessionID: string, details: SessionDetails): void {
    const record = sessionRecords.get(sessionID)
    if (!record || deletedSessionIDs.has(sessionID)) return
    if (typeof details.title === "string") record.title = details.title
    if (record.parentID === undefined) record.parentID = details.parentID
  }
  async function fetchSession(sessionID: string): Promise<SessionDetails | null> {
    try {
      const result = await client.session.get({ path: { id: sessionID } })
      if (!result.data) return null
      return {
        title: result.data.title,
        parentID: getID(result.data.parentID) ?? null,
      }
    } catch { return null }
  }
  function fetchSessionOnce(sessionID: string): Promise<SessionDetails | null> {
    const existing = sessionLookups.get(sessionID)
    if (existing) return existing
    const lookup = fetchSession(sessionID)
    sessionLookups.set(sessionID, lookup)
    lookup.then(() => {
      if (sessionLookups.get(sessionID) === lookup) sessionLookups.delete(sessionID)
    }, () => {
      if (sessionLookups.get(sessionID) === lookup) sessionLookups.delete(sessionID)
    })
    return lookup
  }

  let disposed = false
  let observedState: IndicatorState = "idle"
  let renderTarget: IndicatorState | undefined
  let lastAttemptedState: IndicatorState | undefined
  let renderQueued = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  function enqueueRender(): void {
    if (disposed || renderQueued) return
    renderQueued = true
    enqueueStatus(async () => {
      renderQueued = false
      if (disposed) return
      const target = renderTarget
      if (!target || target === lastAttemptedState) return
      await setStatus(
        $,
        indicatorStatusKey,
        INDICATOR_STYLES[target].text,
        INDICATOR_STYLES[target],
      )
      lastAttemptedState = target
      if (!disposed && renderTarget !== target) enqueueRender()
    })
  }
  function cancelIdle(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }
  function scheduleIdle(): void {
    if (idleTimer !== undefined || disposed) return
    const timer = setTimeout(() => {
      if (idleTimer !== timer) return
      idleTimer = undefined
      if (!disposed && observedState === "idle") {
        renderTarget = "idle"
        enqueueRender()
      }
    }, IDLE_MS)
    idleTimer = timer
  }
  function hasPendingInput(): boolean {
    return pendingPermissions.size > 0 || pendingQuestions.size > 0
  }
  function updateIndicatorState(): void {
    if (disposed) return
    const next: IndicatorState = hasPendingInput()
      ? "needs-input"
      : activeTaskParts.size > 0 ||
          [...sessionRecords.values()].some(
            (record) => record.status === "busy" || record.status === "retry",
          )
        ? "running"
        : "idle"
    if (next === observedState) {
      if (next !== "idle" && renderTarget !== next) { renderTarget = next; enqueueRender() }
      return
    }
    observedState = next
    if (next === "idle") {
      scheduleIdle()
      return
    }
    cancelIdle()
    renderTarget = next
    enqueueRender()
  }

  function taskKey(sessionID: string, messageID: string, partID: string): string {
    return JSON.stringify([sessionID, messageID, partID])
  }
  function removeTasks(sessionID: string, messageID?: string): boolean {
    let changed = false
    for (const [key, part] of activeTaskParts) {
      if (
        part.sessionID === sessionID &&
        (messageID === undefined || part.messageID === messageID)
      ) {
        activeTaskParts.delete(key)
        changed = true
      }
    }
    return changed
  }
  function removeTaskPart(sessionID: string, messageID: string, partID: string): void {
    if (activeTaskParts.delete(taskKey(sessionID, messageID, partID))) updateIndicatorState()
  }
  function updateTaskPart(part: any): void {
    if (part?.type !== "tool" || part.tool !== "task") return
    const sessionID = getID(part.sessionID)
    const messageID = getID(part.messageID)
    const partID = getID(part.id)
    if (
      !sessionID ||
      !messageID ||
      !partID ||
      deletedSessionIDs.has(sessionID) ||
      sessionRecords.get(sessionID)?.status === "error"
    ) return
    const key = taskKey(sessionID, messageID, partID)
    const status = part.state?.status
    if (status === "running") {
      if (!activeTaskParts.has(key)) {
        activeTaskParts.set(key, { sessionID, messageID })
        updateIndicatorState()
      }
    } else if (status === "completed" || status === "error") {
      removeTaskPart(sessionID, messageID, partID)
    }
  }

  function clearOwnedInput(sessionID: string): boolean {
    let changed = false
    for (const map of [pendingPermissions, pendingQuestions, permissionAnnouncements]) {
      for (const [id, owner] of map) {
        if (owner !== sessionID) continue
        map.delete(id)
        if (map !== permissionAnnouncements) changed = true
      }
    }
    return changed
  }
  function cleanupSession(sessionID: string, mode: "delete" | "error"): SessionRecord | undefined {
    if (deletedSessionIDs.has(sessionID)) return undefined
    const record = mode === "delete" ? sessionRecords.get(sessionID) : recordFor(sessionID)
    if (mode === "delete") {
      addTombstone(sessionID)
      sessionRecords.delete(sessionID)
    } else {
      record!.status = "error"
      record!.generation++
      record!.idleHandled = false
    }
    const tasksChanged = removeTasks(sessionID)
    const inputChanged = clearOwnedInput(sessionID)
    const recordChanged = mode === "delete" ? record !== undefined : true
    const changed = tasksChanged || inputChanged || recordChanged
    removeAndClose(sessionID)
    if (changed) updateIndicatorState()
    return record
  }

  function idleIsCurrent(sessionID: string, record: SessionRecord, generation: number): boolean {
    return (
      !disposed &&
      sessionRecords.get(sessionID) === record &&
      !deletedSessionIDs.has(sessionID) &&
      record.status === "idle" &&
      record.generation === generation
    )
  }
  function canComplete(sessionID: string, record: SessionRecord, generation: number): boolean {
    if (!idleIsCurrent(sessionID, record, generation)) return false
    if (hasPendingInput()) { record.idleHandled = false; return false }
    return true
  }
  async function completeSession(sessionID: string, record: SessionRecord, generation: number): Promise<void> {
    if (!canComplete(sessionID, record, generation)) return
    let details: SessionDetails | null = null
    if (record.parentID === undefined) {
      details = await fetchSessionOnce(sessionID)
      if (!canComplete(sessionID, record, generation)) return
      if (details) cacheDetails(sessionID, details)
    }
    if (!canComplete(sessionID, record, generation)) return
    const title = record.title ?? details?.title ?? sessionID
    if (typeof record.parentID === "string") {
      await log($, `Subagent finished: ${title}`, {
        level: "info",
        source: "opencode",
      })
      if (!canComplete(sessionID, record, generation)) return
      removeAndClose(sessionID)
      return
    }
    if (notifyOn.done) {
      await notify($, { title: `Done: ${title}` })
      if (!canComplete(sessionID, record, generation)) return
    }
    if (!canComplete(sessionID, record, generation)) return
    await log($, `Done: ${title}`, { level: "success", source: "opencode" })
  }
  function classifyActive(sessionID: string, record: SessionRecord, generation: number): Promise<void> {
    if (record.parentID !== undefined) return Promise.resolve()
    return fetchSessionOnce(sessionID).then((details) => {
      if (
        !details ||
        disposed ||
        sessionRecords.get(sessionID) !== record ||
        deletedSessionIDs.has(sessionID) ||
        record.generation !== generation ||
        (record.status !== "busy" && record.status !== "retry")
      ) return
      cacheDetails(sessionID, details)
    })
  }
  function reduceStatus(sessionID: string, status: unknown): Promise<void> | undefined {
    if (!sessionID || deletedSessionIDs.has(sessionID)) return
    const record = recordFor(sessionID)
    if (status === "busy" || status === "retry") {
      record.status = status
      record.generation++
      record.idleHandled = false
      updateIndicatorState()
      return classifyActive(sessionID, record, record.generation)
    }
    if (status !== "idle") return
    record.status = "idle"
    updateIndicatorState()
    if (hasPendingInput()) {
      record.idleHandled = false
      return
    }
    if (record.idleHandled) return
    record.idleHandled = true
    record.generation++
    return completeSession(sessionID, record, record.generation)
  }

  function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): boolean {
    if (map.has(key)) return false
    map.set(key, value)
    while (map.size > max) map.delete(map.keys().next().value as K)
    return true
  }
  function trackPending(map: PendingMap, properties: any): { id?: string; owner?: string } {
    const id = askedID(properties)
    const owner = ownerOf(properties)
    if (
      id &&
      !deletedSessionIDs.has(owner ?? "") &&
      (!map.has(id) || map.get(id) !== owner)
    ) {
      map.set(id, owner)
      updateIndicatorState()
    }
    return { id, owner }
  }
  async function announcePermission(id: string | undefined, owner: string | undefined, title: string): Promise<void> {
    if (owner && deletedSessionIDs.has(owner)) return
    if (id !== undefined && !remember(permissionAnnouncements, id, owner, MAX_ANNOUNCEMENTS)) return
    if (notifyOn.permission) {
      await notify($, { title: "Needs your permission", subtitle: title })
    }
    await log($, `Permission requested: ${title}`, {
      level: "info",
      source: "opencode",
    })
  }
  async function reportError(sessionID: string | undefined): Promise<void> {
    if (!sessionID) {
      pendingPermissions.clear()
      pendingQuestions.clear()
      permissionAnnouncements.clear()
      updateIndicatorState()
      if (disposed) return
      if (notifyOn.error) {
        await notify($, { title: "Error: unknown session" })
        if (disposed) return
      }
      if (!disposed) {
        await log($, "Error in session: unknown session", {
          level: "error",
          source: "opencode",
        })
      }
      return
    }
    const record = cleanupSession(sessionID, "error")
    if (!record) return
    const details = record.title ? null : await fetchSessionOnce(sessionID)
    if (disposed || deletedSessionIDs.has(sessionID) || sessionRecords.get(sessionID) !== record) return
    if (details) cacheDetails(sessionID, details)
    const title = record.title ?? details?.title ?? sessionID
    if (notifyOn.error) {
      await notify($, { title: `Error: ${title}` })
      if (disposed) return
    }
    if (!disposed) {
      await log($, `Error in session: ${title}`, {
        level: "error",
        source: "opencode",
      })
    }
  }

  function isTerminal(sessionID: string): boolean {
    if (disposed || deletedSessionIDs.has(sessionID)) return true
    const record = sessionRecords.get(sessionID)
    return !!record && record.generation > 0 && (record.status === "idle" || record.status === "error")
  }
  async function createSubagentSplit(info: any, sessionID: string, url: string): Promise<void> {
    if (isTerminal(sessionID) || activeSplits.has(sessionID)) return
    const n = agentCount
    let direction: SplitDirection, fromSurface: string | undefined
    if (n === 0) { direction = "right"; fromSurface = originalSurfaceId }
    else if (n === 1) { direction = "down"; fromSurface = rowFrontier[0] }
    else if (n === 2) { direction = "down"; fromSurface = originalSurfaceId }
    else { const row = (n - 3) % 3; direction = "right"; fromSurface = rowFrontier[row] }
    const splitID = await createSplit($, direction, fromSurface)
    if (!splitID) return
    if (isTerminal(sessionID)) {
      await closeSurface($, splitID)
      return
    }
    if (n < 3) rowFrontier[n] = splitID
    else rowFrontier[(n - 3) % 3] = splitID
    activeSplits.set(sessionID, splitID)
    agentCount++
    await sendToSurface($, splitID, `opencode attach ${url} --session ${info.id}`)
    if (isTerminal(sessionID)) {
      removeAndClose(sessionID)
      return
    }
    await sendKeyToSurface($, splitID, "enter")
    if (isTerminal(sessionID)) {
      removeAndClose(sessionID)
      return
    }
    if (originalSurfaceId) await focusSurface($, originalSurfaceId)
    if (isTerminal(sessionID)) removeAndClose(sessionID)
  }

  enqueueStatus(() => clearStatus($, "opencode"))
  enqueueStatus(() => clearStatus($, "opencode-subagents"))
  scheduleIdle()

  return {
    async event({ event }) {
      const e = event as any
      if (e.type === "server.instance.disposed" && e.properties?.directory === directory) {
        if (!disposed) {
          disposed = true
          cancelIdle()
          renderTarget = undefined
          statusQueue.length = 0
          renderQueued = false
          closeAllSplits()
          enqueueStatus(() => clearStatus($, indicatorStatusKey))
        }
        return
      }
      if (disposed) return
      if (e.type === "session.created") {
        const info = e.properties?.info
        const sessionID = recordSession(info)
        if (sessionID && splitsEnabled && typeof getID(info?.parentID) === "string") {
          const url = resolveServerUrl()
          if (url) enqueueSplit(() => createSubagentSplit(info, sessionID, url))
        }
        return
      }
      if (e.type === "session.deleted") {
        const p = e.properties ?? {}
        const id = firstID(p.info?.id, p.sessionID, p.id)
        if (id) cleanupSession(id, "delete")
        return
      }
      if (e.type === "message.part.updated") { updateTaskPart(e.properties?.part); return }
      if (e.type === "message.part.removed") {
        const p = e.properties
        const s = getID(p?.sessionID)
        const m = getID(p?.messageID)
        const part = firstID(p?.partID, p?.id)
        if (s && m && part) removeTaskPart(s, m, part)
        return
      }
      if (e.type === "message.removed") {
        const p = e.properties
        const s = getID(p?.sessionID)
        const m = getID(p?.messageID)
        if (s && removeTasks(s, m)) updateIndicatorState()
        return
      }
      if (e.type === "session.status" || e.type === "session.idle") {
        const id = getID(e.properties?.sessionID)
        const status = e.type === "session.idle" ? "idle" : e.properties?.status?.type
        const completion = reduceStatus(id ?? "", status)
        if (completion) await completion
        return
      }
      if (e.type === "session.error") {
        await reportError(getID(e.properties?.sessionID))
        return
      }
      if (PERMISSION_ASKED.has(e.type)) {
        const { id, owner } = trackPending(pendingPermissions, e.properties)
        if (id && !deletedSessionIDs.has(owner ?? "")) {
          await announcePermission(id, owner, permissionLabel(e.properties))
        }
        return
      }
      if (PERMISSION_REPLIED.has(e.type)) {
        const id = permissionReplyID(e.properties)
        if (id) {
          const changed = pendingPermissions.delete(id)
          permissionAnnouncements.delete(id)
          if (changed) updateIndicatorState()
        }
        return
      }
      if (QUESTION_ASKED.has(e.type)) {
        const { id, owner } = trackPending(pendingQuestions, e.properties)
        if (!id || (owner && deletedSessionIDs.has(owner))) return
        const header = e.properties?.questions?.[0]?.header ?? "Question"
        if (notifyOn.question) {
          await notify($, { title: "Has a question", subtitle: header })
        }
        await log($, `Question: ${header}`, {
          level: "info",
          source: "opencode",
        })
        return
      }
      if (QUESTION_REPLIED.has(e.type)) {
        const id = questionReplyID(e.properties)
        if (id && pendingQuestions.delete(id)) updateIndicatorState()
      }
    },
    async "permission.ask"(input) {
      await announcePermission(
        askedID(input as any),
        ownerOf(input as any),
        permissionLabel(input as any),
      )
    },
  }
}

export default plugin
