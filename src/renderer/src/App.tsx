import React, { useState } from 'react'
import Sidebar from './components/Sidebar'
import AppsPage from './pages/AppsPage'
import UploadPage from './pages/UploadPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'

export type PageId = 'apps' | 'upload' | 'tasks' | 'settings'

export default function App(): React.ReactElement {
  const [page, setPage] = useState<PageId>('apps')
  const [selectedAppId, setSelectedAppId] = useState<number | null>(null)

  function renderPage(): React.ReactElement {
    switch (page) {
      case 'apps':
        return <AppsPage onSelectApp={(id) => { setSelectedAppId(id); setPage('upload') }} />
      case 'upload':
        return <UploadPage appId={selectedAppId} onBack={() => setPage('apps')} />
      case 'tasks':
        return <TasksPage />
      case 'settings':
        return <SettingsPage />
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%' }}>
      <Sidebar current={page} onChange={setPage} />
      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {renderPage()}
      </main>
    </div>
  )
}
