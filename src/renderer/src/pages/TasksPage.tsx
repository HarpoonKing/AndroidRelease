import React, { useEffect, useState, useCallback } from 'react'
import type { ReleaseTask, TaskLog } from '../../../../electron/db/schema'

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  uploading: { label: '上传中', color: '#6c63ff' },
  upload_failed: { label: '上传失败', color: '#e05252' },
  pending_review: { label: '审核中', color: '#f0a500' },
  audit_failed: { label: '审核拒绝', color: '#e05252' },
  audit_passed: { label: '审核通过', color: '#4caf7d' },
  scheduled: { label: '定时待发布', color: '#6c63ff' },
  publishing: { label: '发布中', color: '#6c63ff' },
  published: { label: '已发布', color: '#4caf7d' },
  publish_failed: { label: '发布失败', color: '#e05252' },
  canceled: { label: '已终止', color: '#8a8f98' }
}

const PLATFORM_NAMES: Record<string, string> = {
  huawei: '华为',
  honor: '荣耀',
  xiaomi: '小米',
  oppo: 'OPPO',
  vivo: 'Vivo',
  yingyongbao: '应用宝'
}

export default function TasksPage(): React.ReactElement {
  const [tasks, setTasks] = useState<ReleaseTask[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [logs, setLogs] = useState<TaskLog[]>([])

  const loadTasks = useCallback(async () => {
    const list = await window.api.tasks.list()
    setTasks(list)
  }, [])

  useEffect(() => {
    loadTasks()

    const unsubStatus = window.api.on.taskStatusChanged(({ taskId, status }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status } : t))
      )
    })

    const unsubLog = window.api.on.taskLog(({ taskId, level, message, createdAt }) => {
      if (selectedTaskId === taskId) {
        setLogs((prev) => [...prev, { id: Date.now(), taskId, level, message, createdAt: new Date(createdAt) }])
      }
    })

    return () => { unsubStatus(); unsubLog() }
  }, [loadTasks, selectedTaskId])

  async function selectTask(taskId: number): Promise<void> {
    setSelectedTaskId(taskId)
    const taskLogs = await window.api.tasks.logs(taskId)
    setLogs(taskLogs)
  }

  async function handleRetry(taskId: number): Promise<void> {
    await window.api.tasks.retry(taskId)
  }

  async function handleManualConfirm(taskId: number): Promise<void> {
    await window.api.tasks.manualConfirmAudit(taskId)
  }

  async function handleCancel(taskId: number): Promise<void> {
    await window.api.tasks.cancel(taskId)
  }

  async function handleDelete(taskId: number): Promise<void> {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return
    const confirmed = window.confirm(`确定删除任务「${PLATFORM_NAMES[task.platform] || task.platform} v${task.versionName}」吗？删除后日志也会一并移除。`)
    if (!confirmed) return

    const result = await window.api.tasks.delete(taskId)
    if (!result.ok) {
      alert(result.message || '删除失败')
      return
    }

    setTasks((prev) => prev.filter((t) => t.id !== taskId))
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null)
      setLogs([])
    }
  }

  const selected = tasks.find((t) => t.id === selectedTaskId)

  return (
    <div style={{ display: 'flex', gap: 20, height: 'calc(100vh - 48px)' }}>
      {/* Task list */}
      <div style={{ width: 400, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>任务看板</h2>
          <button className="secondary" onClick={loadTasks}>刷新</button>
        </div>

        {tasks.length === 0 && (
          <div style={{ color: 'var(--text-muted)', paddingTop: 40 }}>暂无任务</div>
        )}

        {tasks.map((task) => {
          const s = STATUS_LABEL[task.status] ?? { label: task.status, color: '#888' }
          return (
            <div
              key={task.id}
              onClick={() => selectTask(task.id)}
              style={{
                background: selectedTaskId === task.id ? 'var(--bg-hover)' : 'var(--bg-surface)',
                border: `1px solid ${selectedTaskId === task.id ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 8,
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {PLATFORM_NAMES[task.platform] || task.platform}
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                    v{task.versionName} ({task.versionCode})
                  </span>
                </div>
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: s.color,
                  background: `${s.color}22`,
                  padding: '2px 8px',
                  borderRadius: 4
                }}>
                  {s.label}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {task.apkPath.split('/').pop()} · {new Date(task.createdAt!).toLocaleString()}
              </div>
              {task.scheduledPublishAt && task.status === 'scheduled' && (
                <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
                  📅 定时上架: {new Date(task.scheduledPublishAt).toLocaleString()}
                </div>
              )}

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                {(task.status === 'upload_failed' || task.status === 'publish_failed') && (
                  <button className="secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => handleRetry(task.id)}>
                    重试
                  </button>
                )}
                {['uploading', 'pending_review', 'scheduled', 'publishing'].includes(task.status) && (
                  <button className="secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => handleCancel(task.id)}>
                    终止
                  </button>
                )}
                {task.status === 'pending_review' && task.platform === 'yingyongbao' && (
                  <button className="primary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => handleManualConfirm(task.id)}>
                    标记审核通过
                  </button>
                )}
                <button className="secondary" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => handleDelete(task.id)}>
                  删除
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Log panel */}
      <div style={{ flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {selected ? (
          <>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
              日志 — {PLATFORM_NAMES[selected.platform] || selected.platform} v{selected.versionName}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7 }}>
              {logs.map((log) => (
                <div key={log.id} style={{ color: log.level === 'error' ? 'var(--error)' : log.level === 'warn' ? 'var(--warn)' : 'var(--text-muted)' }}>
                  <span style={{ opacity: 0.5, marginRight: 8 }}>
                    {new Date(log.createdAt!).toLocaleTimeString()}
                  </span>
                  [{log.level.toUpperCase()}] {log.message}
                </div>
              ))}
              {logs.length === 0 && <span style={{ color: 'var(--text-muted)' }}>暂无日志</span>}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
            点击左侧任务查看日志
          </div>
        )}
      </div>
    </div>
  )
}
