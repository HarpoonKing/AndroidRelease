import React, { useEffect, useState } from 'react'
import type { CredentialField } from '../../../../electron/services/base'

interface Props {
  appId: number
  platform: string
  platformName: string
  onClose: () => void
  onSaved: () => void
}

export default function CredentialModal({ appId, platform, platformName, onClose, onSaved }: Props): React.ReactElement {
  const [schema, setSchema] = useState<CredentialField[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.credentials.schema(platform).then(async (fields) => {
      setSchema(fields)
      const defaults: Record<string, string> = {}
      fields.forEach((f) => { defaults[f.key] = '' })
      const saved = await window.api.credentials.get({ appId, platform })
      setValues(saved ?? defaults)
    })
  }, [platform])

  async function handleVerify(): Promise<void> {
    const missing = schema.filter((f) => f.required && !values[f.key]?.trim())
    if (missing.length > 0) {
      setVerifyResult({ ok: false, message: `请先填写必填项: ${missing.map((f) => f.label).join('、')}` })
      return
    }
    setVerifying(true)
    setVerifyResult(null)
    try {
      const result = await window.api.credentials.verify({ platform, credentials: values })
      setVerifyResult(result)
    } catch (err: unknown) {
      setVerifyResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setVerifying(false)
    }
  }

  async function handleSave(): Promise<void> {
    const missing = schema.filter((f) => f.required && !values[f.key]?.trim())
    if (missing.length > 0) {
      setError(`请填写必填项: ${missing.map((f) => f.label).join('、')}`)
      return
    }

    setSaving(true)
    setError(null)
    try {
      await window.api.credentials.save({ appId, platform, credentials: values })
      onSaved()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 24,
        width: 460,
        maxWidth: '90vw'
      }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>
          配置凭证 — {platformName}
        </h3>

        {schema.map((field) => (
          <div className="field" key={field.key}>
            <label>{field.label}{field.required && <span style={{ color: 'var(--error)' }}> *</span>}</label>
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              value={values[field.key] || ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={field.placeholder}
              autoComplete="off"
            />
          </div>
        ))}

        {error && (
          <div style={{ color: 'var(--error)', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        {verifyResult && (
          <div style={{
            fontSize: 12,
            marginBottom: 12,
            padding: '6px 10px',
            borderRadius: 6,
            background: verifyResult.ok ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.10)',
            color: verifyResult.ok ? 'var(--success)' : 'var(--error)'
          }}>
            {verifyResult.ok ? '✓ ' : '✗ '}{verifyResult.message}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="secondary" onClick={onClose}>取消</button>
          <button className="secondary" onClick={handleVerify} disabled={verifying}>
            {verifying ? '验证中...' : '验证'}
          </button>
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
