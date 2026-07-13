import React, { useEffect, useState } from 'react'
import type { App } from '../../../../electron/db/schema'
import type { Platform } from '../../../../electron/preload'
import CredentialModal from '../components/CredentialModal'

interface Props {
  appId: number | null
  onBack: () => void
}

export default function UploadPage({ appId, onBack }: Props): React.ReactElement {
  const [apps, setApps] = useState<App[]>([])
  const [selectedApp, setSelectedApp] = useState<number | null>(appId)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [configuredPlatforms, setConfiguredPlatforms] = useState<string[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  // defaultApkPath: 所有平台共用的默认 APK
  const [defaultApkPath, setDefaultApkPath] = useState<string | null>(null)
  // platformApks: 每个平台独立覆盖的 APK（未设置则使用默认）
  const [platformApks, setPlatformApks] = useState<Record<string, string>>({})
  const [appReleaseVersion, setAppReleaseVersion] = useState('')
  const [versionName, setVersionName] = useState('')
  const [versionCode, setVersionCode] = useState('')
  const [versionAutoFilled, setVersionAutoFilled] = useState(false)
  const [releaseNotes, setReleaseNotes] = useState('功能改进修复已知bug')
  const [scheduledAt, setScheduledAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [credPlatform, setCredPlatform] = useState<string | null>(null)

  useEffect(() => {
    window.api.apps.list().then(setApps)
    window.api.platforms.list().then(setPlatforms)
  }, [])

  useEffect(() => {
    if (!selectedApp) {
      setConfiguredPlatforms([])
      setSelectedPlatforms([])
      return
    }

    window.api.credentials.getConfiguredPlatforms(selectedApp).then((configured: string[]) => {
      setConfiguredPlatforms(configured)
      setSelectedPlatforms(configured)
    })
  }, [selectedApp])

  async function pickDefaultApk(): Promise<void> {
    const path = await window.api.dialog.openApk()
    if (!path) return
    setDefaultApkPath(path)
    try {
      const meta = await window.api.apk.readMeta(path)
      setVersionName(meta.versionName)
      setVersionCode(String(meta.versionCode))
      setVersionAutoFilled(true)
    } catch {
      // APK 解析失败不影响流程，用户可手动填写
    }
  }

  async function pickPlatformApk(platformId: string): Promise<void> {
    const path = await window.api.dialog.openApk()
    if (path) setPlatformApks((prev) => ({ ...prev, [platformId]: path }))
  }

  function clearPlatformApk(platformId: string): void {
    setPlatformApks((prev) => {
      const next = { ...prev }
      delete next[platformId]
      return next
    })
  }

  function togglePlatform(id: string): void {
    setSelectedPlatforms((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    )
  }

  function getApkForPlatform(platformId: string): string | null {
    return platformApks[platformId] ?? defaultApkPath
  }

  async function autoMatchPlatformApks(): Promise<void> {
    if (!selectedApp) {
      alert('请先选择 App')
      return
    }
    if (!appReleaseVersion.trim()) {
      alert('请先填写 App 版号')
      return
    }
    if (selectedPlatforms.length === 0) {
      alert('请至少选择一个目标平台')
      return
    }

    try {
      const result = await window.api.apk.autoMatchByRule({
        appId: selectedApp,
        releaseVersion: appReleaseVersion,
        platforms: selectedPlatforms
      })

      if (Object.keys(result.matched).length > 0) {
        setPlatformApks((prev) => ({ ...prev, ...result.matched }))
      }

      if (result.missing.length === 0) {
        return
      }

      const missingText = result.missing
        .map((m: { platform: string; expectedFileName: string; expectedPath: string; reason?: string }) => {
          const displayName = platforms.find((p) => p.id === m.platform)?.displayName || m.platform
          if (m.reason) return `${displayName}: ${m.reason}`
          return `${displayName}: ${m.expectedFileName}`
        })
        .join('\n')
      alert(`部分平台未匹配到 APK：\n${missingText}`)
    } catch (err: unknown) {
      alert(`自动匹配失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!selectedApp || !versionName || !versionCode || !releaseNotes.trim() || selectedPlatforms.length === 0) {
      alert('请填写所有必填项并至少选择一个平台')
      return
    }

    // Check every selected platform has an APK (either default or per-platform)
    const missingApk = selectedPlatforms.filter((p) => !getApkForPlatform(p))
    if (missingApk.length > 0) {
      const names = missingApk.map((id) => platforms.find((p) => p.id === id)?.displayName || id).join('、')
      alert(`以下平台未指定 APK：${names}\n请选择默认 APK 或为各平台单独指定 APK`)
      return
    }

    // Check that all selected platforms have credentials
    const missing = selectedPlatforms.filter((p) => !configuredPlatforms.includes(p))
    if (missing.length > 0) {
      const names = missing.map((id) => platforms.find((p) => p.id === id)?.displayName || id).join('、')
      alert(`以下平台尚未配置凭证：${names}\n请先点击各平台的"配置凭证"按钮`)
      return
    }

    // Build platformApks map (only include entries that differ from default, but send all for clarity)
    const apksPayload: Record<string, string> = {}
    for (const p of selectedPlatforms) {
      const path = getApkForPlatform(p)
      if (path) apksPayload[p] = path
    }

    setSubmitting(true)
    try {
      const result = await window.api.tasks.create({
        appId: selectedApp,
        platforms: selectedPlatforms,
        platformApks: apksPayload,
        defaultApkPath: defaultApkPath ?? undefined,
        versionName,
        versionCode: parseInt(versionCode, 10),
        releaseNotes,
        scheduledPublishAt: scheduledAt || undefined
      })
      alert(`已创建 ${result.taskIds.length} 个上传任务，请在"任务看板"查看进度`)
      onBack()
    } catch (err: unknown) {
      alert(`创建任务失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button className="secondary" onClick={onBack}>← 返回</button>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>上传 & 发布</h2>
      </div>

      {/* App selector */}
      <div className="field">
        <label>选择 App *</label>
        <select value={selectedApp ?? ''} onChange={(e) => setSelectedApp(Number(e.target.value) || null)}>
          <option value="">请选择...</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>{a.name} ({a.bundleId})</option>
          ))}
        </select>
      </div>

      {/* Default APK */}
      <div className="field">
        <label>默认 APK（所有平台共用，可被各平台单独覆盖）</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="secondary" onClick={pickDefaultApk}>选择 APK</button>
          {defaultApkPath
            ? <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{defaultApkPath.split('/').pop()}</span>
            : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>未选择（需为各平台单独指定）</span>
          }
        </div>
      </div>

      <div className="field">
        <label>App 版号（用于自动匹配文件名）</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={appReleaseVersion}
            onChange={(e) => setAppReleaseVersion(e.target.value)}
            placeholder="例如 1.2.5"
            style={{ flex: 1 }}
          />
          <button className="secondary" onClick={autoMatchPlatformApks}>按规则自动匹配 APK</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          规则：输入版号如 1.2.5，会转为 125；在 APK根目录/1.2.5/ 下匹配别名_125_平台序号_平台名称_sign.apk
        </div>
      </div>

      {/* Platform selection + per-platform APK override */}
      <div className="field">
        <label>目标平台 *</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {platforms.map((p) => {
            const configured = configuredPlatforms.includes(p.id)
            const checked = selectedPlatforms.includes(p.id)
            const overrideApk = platformApks[p.id]
            const effectiveApk = getApkForPlatform(p.id)

            return (
              <div
                key={p.id}
                style={{
                  background: checked ? 'rgba(108,99,255,0.10)' : 'var(--bg-surface)',
                  border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                {/* Platform header row */}
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: selectedApp ? 'pointer' : 'default' }}
                  onClick={() => selectedApp && togglePlatform(p.id)}
                >
                  <label
                    style={{ cursor: 'pointer', margin: 0, color: 'var(--text)', fontWeight: checked ? 600 : 400, display: 'flex', alignItems: 'center', gap: 6 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => selectedApp && togglePlatform(p.id)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 18, height: 18, margin: 0, flexShrink: 0 }}
                    />
                    {p.displayName}
                  </label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {configured
                      ? <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ 已配置凭证</span>
                      : selectedApp
                        ? <button
                            className="secondary"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              setCredPlatform(p.id)
                            }}
                          >配置凭证</button>
                        : null
                    }
                  </div>
                </div>

                {/* Per-platform APK override (only when platform is selected) */}
                {checked && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      className="secondary"
                      style={{ fontSize: 11, padding: '3px 10px', whiteSpace: 'nowrap' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        pickPlatformApk(p.id)
                      }}
                    >
                      {overrideApk ? '更换 APK' : '使用不同 APK'}
                    </button>
                    {overrideApk
                      ? <>
                          <span style={{ fontSize: 11, color: 'var(--accent)' }}>{overrideApk.split('/').pop()}</span>
                          <button
                            className="secondary"
                            style={{ fontSize: 11, padding: '2px 6px' }}
                            onClick={(e) => {
                              e.stopPropagation()
                              clearPlatformApk(p.id)
                            }}
                          >✕</button>
                        </>
                      : effectiveApk
                        ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>使用默认：{effectiveApk.split('/').pop()}</span>
                        : <span style={{ fontSize: 11, color: 'var(--error)' }}>⚠ 未指定 APK</span>
                    }
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label>
            版本名称 (versionName) *
            {versionAutoFilled && <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 6 }}>✓ 自动读取</span>}
          </label>
          <input
            value={versionName}
            onChange={(e) => { setVersionName(e.target.value); setVersionAutoFilled(false) }}
            placeholder="1.0.0"
          />
        </div>
        <div className="field">
          <label>
            版本号 (versionCode) *
            {versionAutoFilled && <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 6 }}>✓ 自动读取</span>}
          </label>
          <input
            type="number"
            value={versionCode}
            onChange={(e) => { setVersionCode(e.target.value); setVersionAutoFilled(false) }}
            placeholder="100"
          />
        </div>
      </div>

      <div className="field">
        <label>更新说明 *</label>
        <textarea
          rows={3}
          value={releaseNotes}
          onChange={(e) => setReleaseNotes(e.target.value)}
          placeholder="本次更新内容..."
          style={{ resize: 'vertical' }}
        />
      </div>

      <div className="field">
        <label>定时上架时间（审核通过后，留空则立即上架）</label>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
        />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          设置后，审核通过后将等到该时间再触发上架
        </div>
      </div>

      <button
        className="primary"
        onClick={handleSubmit}
        disabled={submitting}
        style={{ width: '100%', padding: '10px', fontSize: 14, marginTop: 8 }}
      >
        {submitting ? '提交中...' : '🚀 开始上传'}
      </button>

      {credPlatform && selectedApp && (
        <CredentialModal
          appId={selectedApp}
          platform={credPlatform}
          platformName={platforms.find((p) => p.id === credPlatform)?.displayName || credPlatform}
          onClose={() => setCredPlatform(null)}
          onSaved={() => {
            setCredPlatform(null)
            window.api.credentials.getConfiguredPlatforms(selectedApp).then((configured: string[]) => {
              setConfiguredPlatforms(configured)
              setSelectedPlatforms((prev) => Array.from(new Set([...prev, ...configured])))
            })
          }}
        />
      )}
    </div>
  )
}

