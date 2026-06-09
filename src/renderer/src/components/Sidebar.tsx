import React from 'react'
import type { PageId } from '../App'

const items: { id: PageId; label: string; icon: string }[] = [
  { id: 'apps', label: 'App 管理', icon: '📦' },
  { id: 'upload', label: '上传发布', icon: '🚀' },
  { id: 'tasks', label: '任务看板', icon: '📋' },
  { id: 'settings', label: '设置', icon: '⚙️' }
]

interface Props {
  current: PageId
  onChange: (p: PageId) => void
}

export default function Sidebar({ current, onChange }: Props): React.ReactElement {
  const topPadding = navigator.userAgent.includes('Mac') ? 44 : 16

  return (
    <nav
      style={{
        width: 'var(--sidebar-w)',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: `${topPadding}px 0 16px`,
        WebkitAppRegion: 'drag' as never
      }}
    >
      <div style={{ padding: '0 16px 20px', fontSize: 15, fontWeight: 700, letterSpacing: 0.5 }}>
        AndroidRelease
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onChange(item.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 16px',
            background: current === item.id ? 'var(--bg-hover)' : 'transparent',
            color: current === item.id ? 'var(--text)' : 'var(--text-muted)',
            borderRadius: 0,
            fontWeight: current === item.id ? 600 : 400,
            borderLeft: current === item.id ? '3px solid var(--accent)' : '3px solid transparent',
            WebkitAppRegion: 'no-drag' as never,
            textAlign: 'left',
            width: '100%'
          }}
        >
          <span>{item.icon}</span>
          {item.label}
        </button>
      ))}
    </nav>
  )
}
