import axios from 'axios'
import FormData from 'form-data'
import { createReadStream, statSync } from 'fs'
import * as crypto from 'crypto'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * 小米应用商店 Open API
 * Docs: https://dev.mi.com/distribute/doc/details?pId=1095
 * Auth: username + private_key (UserKey Signature)
 */

const XIAOMI_BASE = 'https://api.developer.xiaomi.com/appstore/v1'

function buildSign(params: Record<string, string>, privateKey: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return crypto.createHmac('sha1', privateKey).update(sorted).digest('hex')
}

export class XiaomiService implements PlatformService {
  readonly platform = 'xiaomi'
  readonly displayName = '小米应用商店'

  getCredentialSchema(): CredentialField[] {
    return [
      { key: 'username', label: '开发者账号', type: 'text', required: true, placeholder: '小米开发者邮箱' },
      { key: 'privateKey', label: 'Private Key', type: 'password', required: true, placeholder: '小米开放平台 Private Key' },
      { key: 'packageName', label: '包名 (Package Name)', type: 'text', required: true, placeholder: 'com.example.app' }
    ]
  }

  private commonParams(creds: Record<string, string>): Record<string, string> {
    const params: Record<string, string> = {
      username: creds.username,
      nonce: `${Date.now()}`,
      timestamp: `${Math.floor(Date.now() / 1000)}`
    }
    params.sign = buildSign(params, creds.privateKey)
    return params
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const form = new FormData()
    const params = this.commonParams(creds)
    for (const [k, v] of Object.entries(params)) form.append(k, v)

    form.append('package_name', creds.packageName)
    form.append('version_name', meta.versionName)
    form.append('version_code', String(meta.versionCode))
    if (meta.releaseNotes) form.append('update_desc', meta.releaseNotes)
    form.append('apk', createReadStream(apkPath), {
      filename: apkPath.split('/').pop(),
      contentType: 'application/vnd.android.package-archive',
      knownLength: statSync(apkPath).size
    })

    const res = await axios.post<{ success: boolean; data: { app_id: string }; descEN: string }>(
      `${XIAOMI_BASE}/apk/upload`,
      form,
      { headers: form.getHeaders() }
    )

    if (!res.data?.success) {
      throw new PlatformApiError('xiaomi', 'UPLOAD_FAILED', res.data?.descEN || 'Upload failed')
    }

    return res.data.data.app_id
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const params = { ...this.commonParams(creds), app_id: auditTaskId }

    const res = await axios.get<{
      success: boolean
      data: { audit_status: number }
      descEN: string
    }>(`${XIAOMI_BASE}/apk/info`, { params })

    if (!res.data?.success) {
      throw new PlatformApiError('xiaomi', 'STATUS_FAILED', res.data?.descEN || 'Status check failed')
    }

    // audit_status: 1=审核中, 2=审核通过, 3=审核拒绝
    const s = res.data.data?.audit_status
    if (s === 1) return 'pending'
    if (s === 2) return 'passed'
    if (s === 3) return 'failed'
    return 'pending'
  }

  async publish(auditTaskId: string, creds: Record<string, string>): Promise<void> {
    const params = { ...this.commonParams(creds), app_id: auditTaskId }
    const form = new FormData()
    for (const [k, v] of Object.entries(params)) form.append(k, v)

    const res = await axios.post<{ success: boolean; descEN: string }>(
      `${XIAOMI_BASE}/apk/publish`,
      form,
      { headers: form.getHeaders() }
    )

    if (!res.data?.success) {
      throw new PlatformApiError('xiaomi', 'PUBLISH_FAILED', res.data?.descEN || 'Publish failed')
    }
  }
}
