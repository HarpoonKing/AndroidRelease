import React, { useEffect, useState } from 'react'
import type { App } from '../../../../electron/db/schema'

interface Props {
  onSelectApp: (appId: number) => void
}

export default function AppsPage({ onSelectApp }: Props): React.ReactElement {
  const [apps, setApps] = useState<App[]>([])
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [copyFromAppId, setCopyFromAppId] = useState<number | ''>('')
  const [appsWithCredentials, setAppsWithCredentials] = useState<App[]>([])

  async function loadApps(): Promise<void> {
    const list = await window.api.apps.list()
    setApps(list)
    // Determine which apps have at least one configured credential
    const withCreds = await Promise.all(
      list.map(async (app) => {
        const configured = await window.api.credentials.getConfiguredPlatforms(app.id)
        return configured.length > 0 ? app : null
      })
    )
    setAppsWithCredentials(withCreds.filter((a): a is App => a !== null))
  }

  useEffect(() => { loadApps() }, [])

  async function handleCreate(): Promise<void> {
    if (!name.trim() || !bundleId.trim()) return
    const newApp = await window.api.apps.create({ name, bundleId, iconPath: iconPath ?? undefined })
    if (copyFromAppId !== '') {
      await window.api.credentials.copyFrom({ fromAppId: copyFromAppId, toAppId: newApp.id })
    }
    setName(''); setBundleId(''); setIconPath(null); setCopyFromAppId(''); setShowForm(false)
    loadApps()
  }

  async function handleDelete(id: number): Promise<void> {
    if (!confirm('确认删除该 App 及所有相关数据？')) return
    await window.api.apps.delete(id)
    loadApps()
  }

  async function pickIcon(): Promise<void> {
    const path = await window.api.dialog.openImage()
    if (path) setIconPath(path)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700 }}>App 管理</h2>
        <button className="primary" onClick={() => setShowForm(true)}>+ 添加 App</button>
      </div>

      {showForm && (
        <div style={cardStyle}>
          <h3 style={{ marginBottom: 14, fontSize: 14, fontWeight: 600 }}>添加新 App</h3>
          <div className="field">
            <label>App 名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="我的应用" />
          </div>
          <div className="field">
            <label>包名 (Bundle ID)</label>
            <input value={bundleId} onChange={(e) => setBundleId(e.target.value)} placeholder="com.example.app" />
          </div>
          <div className="field">
            <label>图标 (可选)</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="secondary" onClick={pickIcon}>选择图片</button>
              {iconPath && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{iconPath.split('/').pop()}</span>}
            </div>
          </div>
          {appsWithCredentials.length > 0 && (
            <div className="field">
              <label>复制凭证自 (可选)</label>
              <select
                value={copyFromAppId}
                onChange={(e) => setCopyFromAppId(e.target.value === '' ? '' : Number(e.target.value))}
                style={{ width: '100%' }}
              >
                <option value="">不复制</option>
                {appsWithCredentials.map((app) => (
                  <option key={app.id} value={app.id}>{app.name}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="primary" onClick={handleCreate}>创建</button>
            <button className="secondary" onClick={() => setShowForm(false)}>取消</button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {apps.map((app) => (
          <div key={app.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              {app.iconPath
                ? <img src={`file://${app.iconPath}`} style={{ width: 40, height: 40, borderRadius: 8 }} />
                : <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📦</div>
              }
              <div>
                <div style={{ fontWeight: 600 }}>{app.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{app.bundleId}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="primary" style={{ flex: 1 }} onClick={() => onSelectApp(app.id)}>上传发布</button>
              <button className="danger" onClick={() => handleDelete(app.id)}>删除</button>
            </div>
          </div>
        ))}
        {apps.length === 0 && !showForm && (
          <div style={{ color: 'var(--text-muted)', padding: '40px 0' }}>暂无 App，点击"添加 App"开始</div>
        )}
      </div>
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 16,
  marginBottom: 16
}
