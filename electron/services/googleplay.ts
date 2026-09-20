import axios from 'axios'
import { createReadStream } from 'fs'
import { extname } from 'path'
import { createSign } from 'crypto'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ANDROID_PUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
const ANDROID_PUBLISHER_UPLOAD_BASE = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3'
const SCOPE_ANDROID_PUBLISHER = 'https://www.googleapis.com/auth/androidpublisher'

const TOKEN_TIMEOUT_MS = 15_000
const API_TIMEOUT_MS = 60_000
const UPLOAD_TIMEOUT_MS = 20 * 60_000

type AccessTokenCache = {
  accessToken: string
  expiresAt: number
}

type AuditRef = {
  packageName: string
  track: string
}

const tokenCache = new Map<string, AccessTokenCache>()

function toBase64Url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function normalizePrivateKey(raw: string): string {
  return raw.trim().replace(/\\n/g, '\n')
}

function normalizeCreds(creds: Record<string, string>): {
  serviceEmail: string
  privateKey: string
  packageName: string
  track: string
} {
  const serviceEmail = (creds.serviceEmail || creds.clientEmail || '').trim()
  const privateKey = normalizePrivateKey(creds.privateKey || creds.private_key || '')
  const packageName = (creds.packageName || creds.pkgName || '').trim()
  const track = (creds.track || 'production').trim() || 'production'
  return { serviceEmail, privateKey, packageName, track }
}

function assertRequiredCreds(creds: Record<string, string>): {
  serviceEmail: string
  privateKey: string
  packageName: string
  track: string
} {
  const normalized = normalizeCreds(creds)
  const missing: string[] = []
  if (!normalized.serviceEmail) missing.push('serviceEmail')
  if (!normalized.privateKey) missing.push('privateKey')
  if (!normalized.packageName) missing.push('packageName')
  if (missing.length > 0) {
    throw new PlatformApiError('googleplay', 'MISSING_CREDENTIALS', `缺少必填凭证: ${missing.join(', ')}`)
  }
  return normalized
}

function createJwtAssertion(serviceEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iss: serviceEmail,
    scope: SCOPE_ANDROID_PUBLISHER,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }

  const encodedHeader = toBase64Url(JSON.stringify(header))
  const encodedPayload = toBase64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

  return `${signingInput}.${signature}`
}

async function getAccessToken(serviceEmail: string, privateKey: string): Promise<string> {
  const cacheKey = `${serviceEmail}::${privateKey.slice(0, 24)}`
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken
  }

  const assertion = createJwtAssertion(serviceEmail, privateKey)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  })

  const res = await axios.post<{
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }>(GOOGLE_TOKEN_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: TOKEN_TIMEOUT_MS
  })

  if (!res.data?.access_token) {
    throw new PlatformApiError(
      'googleplay',
      res.data?.error || 'AUTH_FAILED',
      res.data?.error_description || '获取 Google Play access token 失败'
    )
  }

  const expiresInMs = (res.data.expires_in ?? 3600) * 1000
  tokenCache.set(cacheKey, {
    accessToken: res.data.access_token,
    expiresAt: Date.now() + expiresInMs
  })

  return res.data.access_token
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`
  }
}

function isAxiosErrorWithResponse(err: unknown): err is Error & { response: { status: number; data?: unknown } } {
  return axios.isAxiosError(err) && !!err.response
}

function toApiError(stage: string, err: unknown): PlatformApiError {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status ?? 'N/A'
    const data = err.response?.data
    const message = typeof data === 'string' ? data : JSON.stringify(data ?? {})
    return new PlatformApiError('googleplay', `HTTP_${status}`, `${stage}失败: ${message || err.message}`)
  }
  return new PlatformApiError('googleplay', 'STAGE_FAILED', `${stage}失败: ${err instanceof Error ? err.message : String(err)}`)
}

function parseAuditRef(auditTaskId: string, fallbackPackageName: string, fallbackTrack: string): AuditRef {
  try {
    const parsed = JSON.parse(auditTaskId) as Partial<AuditRef>
    return {
      packageName: parsed.packageName || fallbackPackageName,
      track: parsed.track || fallbackTrack
    }
  } catch {
    return {
      packageName: fallbackPackageName,
      track: fallbackTrack
    }
  }
}

function resolveReleaseStatus(creds: Record<string, string>): 'completed' | 'draft' | 'inProgress' {
  const raw = (creds.releaseStatus || 'completed').trim()
  if (raw === 'draft' || raw === 'inProgress' || raw === 'completed') {
    return raw
  }
  return 'completed'
}

function resolveRolloutFraction(creds: Record<string, string>): number | undefined {
  const raw = (creds.rolloutFraction || '').trim()
  if (!raw) return undefined
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0 || num >= 1) {
    throw new PlatformApiError('googleplay', 'INVALID_ROLLOUT', 'rolloutFraction 必须是 0 到 1 之间的小数，例如 0.2')
  }
  return num
}

async function createEdit(packageName: string, accessToken: string): Promise<string> {
  const res = await axios.post<{ id?: string }>(
    `${ANDROID_PUBLISHER_BASE}/applications/${encodeURIComponent(packageName)}/edits`,
    {},
    {
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT_MS
    }
  )
  if (!res.data?.id) {
    throw new PlatformApiError('googleplay', 'NO_EDIT_ID', '创建 Google Play edit 失败')
  }
  return res.data.id
}

async function uploadBundle(
  packageName: string,
  editId: string,
  bundlePath: string,
  accessToken: string
): Promise<string> {
  const res = await axios.post<{ versionCode?: number | string }>(
    `${ANDROID_PUBLISHER_UPLOAD_BASE}/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/bundles`,
    createReadStream(bundlePath),
    {
      params: { uploadType: 'media' },
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/octet-stream' },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  )
  if (!res.data?.versionCode) {
    throw new PlatformApiError('googleplay', 'NO_VERSION_CODE', '上传 AAB 成功但未返回 versionCode')
  }
  return String(res.data.versionCode)
}

async function updateTrackRelease(
  packageName: string,
  editId: string,
  track: string,
  versionCode: string,
  meta: UploadMeta,
  creds: Record<string, string>,
  accessToken: string
): Promise<void> {
  const status = resolveReleaseStatus(creds)
  const userFraction = resolveRolloutFraction(creds)

  const release: {
    name?: string
    status: 'completed' | 'draft' | 'inProgress'
    versionCodes: string[]
    releaseNotes?: Array<{ language: string; text: string }>
    userFraction?: number
  } = {
    status,
    versionCodes: [versionCode]
  }

  if (meta.versionName?.trim()) {
    release.name = meta.versionName.trim()
  }

  if (meta.releaseNotes?.trim()) {
    release.releaseNotes = [{ language: 'zh-CN', text: meta.releaseNotes.trim() }]
  }

  if (status === 'inProgress') {
    release.userFraction = userFraction ?? 0.1
  }

  await axios.put(
    `${ANDROID_PUBLISHER_BASE}/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`,
    { releases: [release] },
    {
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT_MS
    }
  )
}

async function commitEdit(
  packageName: string,
  editId: string,
  changesNotSentForReview: boolean,
  accessToken: string
): Promise<void> {
  await axios.post(
    `${ANDROID_PUBLISHER_BASE}/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}:commit`,
    {},
    {
      params: { changesNotSentForReview: changesNotSentForReview ? 'true' : 'false' },
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      timeout: API_TIMEOUT_MS
    }
  )
}

export class GooglePlayService implements PlatformService {
  readonly platform = 'googleplay'
  readonly displayName = 'Google Play'

  getCredentialSchema(): CredentialField[] {
    return [
      {
        key: 'serviceEmail',
        label: 'Service Account Email',
        type: 'text',
        required: true,
        placeholder: 'xxx@xxx.iam.gserviceaccount.com'
      },
      {
        key: 'privateKey',
        label: 'Private Key',
        type: 'password',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----...'
      },
      {
        key: 'packageName',
        label: 'Package Name',
        type: 'text',
        required: true,
        placeholder: 'com.example.app'
      },
      {
        key: 'track',
        label: 'Track',
        type: 'text',
        required: false,
        placeholder: 'production / beta / alpha / internal'
      },
      {
        key: 'releaseStatus',
        label: 'Release Status',
        type: 'text',
        required: false,
        placeholder: 'completed / draft / inProgress（默认 completed）'
      },
      {
        key: 'rolloutFraction',
        label: 'Rollout Fraction',
        type: 'text',
        required: false,
        placeholder: '仅 inProgress 使用，例如 0.2'
      },
      {
        key: 'changesNotSentForReview',
        label: 'Changes Not Sent For Review',
        type: 'text',
        required: false,
        placeholder: 'true / false（默认 false）'
      }
    ]
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const normalized = assertRequiredCreds(creds)
    if (extname(apkPath).toLowerCase() !== '.aab') {
      throw new PlatformApiError('googleplay', 'INVALID_FILE_TYPE', 'Google Play 仅支持 AAB 上传，请选择 .aab 文件')
    }

    const changesNotSentForReview = (creds.changesNotSentForReview || '').trim().toLowerCase() === 'true'

    try {
      const accessToken = await getAccessToken(normalized.serviceEmail, normalized.privateKey)
      const editId = await createEdit(normalized.packageName, accessToken)
      const versionCode = await uploadBundle(normalized.packageName, editId, apkPath, accessToken)
      await updateTrackRelease(normalized.packageName, editId, normalized.track, versionCode, meta, creds, accessToken)
      await commitEdit(normalized.packageName, editId, changesNotSentForReview, accessToken)

      return JSON.stringify({ packageName: normalized.packageName, track: normalized.track })
    } catch (err) {
      throw toApiError('Google Play 上传/发布', err)
    }
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const normalized = assertRequiredCreds(creds)
    const ref = parseAuditRef(auditTaskId, normalized.packageName, normalized.track)

    try {
      const accessToken = await getAccessToken(normalized.serviceEmail, normalized.privateKey)
      const res = await axios.get<{
        releases?: Array<{ status?: string }>
      }>(
        `${ANDROID_PUBLISHER_BASE}/applications/${encodeURIComponent(ref.packageName)}/tracks/${encodeURIComponent(ref.track)}`,
        {
          headers: authHeaders(accessToken),
          timeout: API_TIMEOUT_MS
        }
      )

      const statuses = (res.data.releases || []).map((r) => (r.status || '').toLowerCase())
      if (statuses.includes('draft')) return 'pending'
      if (statuses.some((s) => s === 'completed' || s === 'inprogress' || s === 'halted')) return 'passed'
      return 'pending'
    } catch (err) {
      if (isAxiosErrorWithResponse(err) && err.response.status === 404) {
        return 'pending'
      }
      throw toApiError('Google Play 查询状态', err)
    }
  }

  async publish(_auditTaskId: string, _creds: Record<string, string>): Promise<void> {
    // Google Play 在 upload() 中已完成 edit commit；这里保持幂等 no-op。
    return
  }

  async verify(creds: Record<string, string>): Promise<void> {
    const normalized = assertRequiredCreds(creds)
    await getAccessToken(normalized.serviceEmail, normalized.privateKey)
  }
}
