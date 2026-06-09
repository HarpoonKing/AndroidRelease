import React, { useEffect, useState } from 'react'
import type { Platform } from '../../../../electron/preload'
import CredentialModal from '../components/CredentialModal'
import type { App } from '../../../../electron/db/schema'

export default function SettingsPage(): React.ReactElement {
  const [apps, setApps] = useState<App[]>([])
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [configuredMap, setConfiguredMap] = useState<Record<number, string[]>>({})
  const [editing, setEditing] = useState<{ appId: number; platform: string } | null>(null)

  useEffect(() => {
    window.api.apps.list().then(setApps)
    window.api.platforms.list().then(setPlatforms)
  }, [])

  useEffect(() => {
    Promise.all(apps.map(async (app) => {
      const configured = await window.api.credentials.getConfiguredPlatforms(app.id)
      return [app.id, configured] as [number, string[]]
    })).then((pairs) => {
      setConfiguredMap(Object.fromEntries(pairs))
    })
  }, [apps])

  async function refreshConfigured(appId: number): Promise<void> {
    const configured = await window.api.credentials.getConfiguredPlatforms(appId)
    setConfiguredMap((prev) => ({ ...prev, [appId]: configured }))
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>平台凭证配置</h2>

      {apps.length === 0 && (
        <div style={{ color: 'var(--text-muted)' }}>请先在"App 管理"中添加 App</div>
      )}

      {apps.map((app) => (
        <div key={app.id} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>{app.name} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>({app.bundleId})</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            {platforms.map((p) => {
              const configured = configuredMap[app.id]?.includes(p.id)
              return (
                <div key={p.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{p.displayName}</span>
                    {configured
                      ? <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ 已配置</span>
                      : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>未配置</span>
                    }
                  </div>
                  <button
                    className="secondary"
                    style={{ width: '100%', fontSize: 12 }}
                    onClick={() => setEditing({ appId: app.id, platform: p.id })}
                  >
                    {configured ? '修改凭证' : '配置凭证'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginTop: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>⚠️ 平台权限说明</h3>
        <ul style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 2, paddingLeft: 20 }}>
          <li><strong style={{ color: 'var(--text)' }}>Vivo：</strong>需在 Vivo 开发者后台手动申请"管理中心 → API 传包"权限</li>
          <li><strong style={{ color: 'var(--text)' }}>OPPO：</strong>需在控制台申请并配置 IP 白名单</li>
          <li><strong style={{ color: 'var(--text)' }}>应用宝：</strong>需申请"API 传包"权限，且审核状态不支持 API 查询（需手动确认）</li>
          <li><strong style={{ color: 'var(--text)' }}>华为/荣耀：</strong>在 AGC 控制台创建 API Client 并获取 Client ID / Secret</li>
          <li><strong style={{ color: 'var(--text)' }}>小米：</strong>在开发者后台"账号设置"中获取 Private Key</li>
        </ul>
      </div>

      {editing && (
        <CredentialModal
          appId={editing.appId}
          platform={editing.platform}
          platformName={platforms.find((p) => p.id === editing.platform)?.displayName || editing.platform}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refreshConfigured(editing.appId)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
