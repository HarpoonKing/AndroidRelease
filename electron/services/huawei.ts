import axios from 'axios'
import FormData from 'form-data'
import { createReadStream } from 'fs'
import type {
  PlatformService,
  CredentialField,
  UploadMeta,
  AuditStatus
} from './base'
import { PlatformApiError } from './base'

/**
 * 华为 AppGallery Connect Open API
 * Docs: https://developer.huawei.com/consumer/cn/doc/development/AppGallery-connect-Guides/agapi-getstarted-0000001111845114
 *
 * Auth: OAuth2 Client Credentials
 * Flow: getToken → getUploadUrl → uploadFile → submitAppInfo
 */

const AGC_TOKEN_URL = 'https://connect-api.cloud.huawei.com/api/oauth2/v1/token'
// AppGallery Connect 发布接口仅有 v2 版本（v1 不存在，会返回 404）
const AGC_BASE_CANDIDATES = [
  'https://connect-api.cloud.huawei.com/api/publish/v2'
]
const TOKEN_TIMEOUT_MS = 10_000
const META_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000
const SUBMIT_TIMEOUT_MS = 60_000

// 上传后华为后台需要编译 APK，提交审核时可能返回此错误码，需等待数分钟后重试
const PACKAGE_COMPILING_CODE = 204144727
const SUBMIT_MAX_RETRIES = 6
const SUBMIT_RETRY_DELAY_MS = 60_000

interface HuaweiToken {
  access_token: string
  expires_in: number
  _fetchedAt: number
}

const tokenCache = new Map<string, HuaweiToken>()

async function fetchToken(clientId: string, clientSecret: string): Promise<HuaweiToken> {
  const res = await axios.post<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
    AGC_TOKEN_URL,
    { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    { headers: { 'Content-Type': 'application/json' }, timeout: TOKEN_TIMEOUT_MS }
  )
  if (res.data?.error || !res.data?.access_token) {
    const msg = res.data?.error_description || res.data?.error || 'Failed to obtain access token'
    throw new PlatformApiError('huawei', res.data?.error ?? 'AUTH_FAILED', msg)
  }
  return { access_token: res.data.access_token, expires_in: res.data.expires_in ?? 3600, _fetchedAt: Date.now() }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = clientId
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() - cached._fetchedAt < (cached.expires_in - 60) * 1000) {
    return cached.access_token
  }
  tokenCache.delete(cacheKey)

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1500))
    try {
      const token = await fetchToken(clientId, clientSecret)
      tokenCache.set(cacheKey, token)
      return token.access_token
    } catch (err) {
      lastErr = err
      // Only retry on 5xx / network errors; fail fast on 4xx (bad credentials)
      if (axios.isAxiosError(err) && err.response && err.response.status < 500) break
    }
  }
  throw lastErr
}

async function getHeaders(clientId: string, clientSecret: string) {
  const token = await getAccessToken(clientId, clientSecret)
  return {
    Authorization: `Bearer ${token}`,
    client_id: clientId
  }
}

function is404Error(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404
}

function isTimeoutError(err: unknown): boolean {
  return axios.isAxiosError(err) && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message))
}

function stageError(stage: string, err: unknown): never {
  if (isTimeoutError(err)) {
    throw new PlatformApiError('huawei', 'TIMEOUT', `${stage}超时，请重试或调大超时时间`)
  }
  throw err instanceof Error
    ? new PlatformApiError('huawei', 'STAGE_FAILED', `${stage}失败: ${err.message}`)
    : new PlatformApiError('huawei', 'STAGE_FAILED', `${stage}失败: ${String(err)}`)
}

export class HuaweiService implements PlatformService {
  readonly platform = 'huawei'
  readonly displayName = '华为应用市场'

  getCredentialSchema(): CredentialField[] {
    return [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: '华为 AGC Client ID' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: '华为 AGC Client Secret' },
      { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'AGC 应用 ID (数字)' }
    ]
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const headers = await getHeaders(creds.clientId, creds.clientSecret)

    let lastErr: unknown
    for (const base of AGC_BASE_CANDIDATES) {
      try {
        // Step 1: Get upload URL
        const urlRes = await axios.get<{ uploadUrl: string; authCode: string; chunkUploadURL: string }>(
          `${base}/upload-url`,
          {
            params: { appId: creds.appId, suffix: 'apk' },
            headers,
            timeout: META_TIMEOUT_MS
          }
        ).catch((err) => stageError('获取华为上传地址', err))
        if (!urlRes.data?.uploadUrl) {
          throw new PlatformApiError('huawei', 'NO_UPLOAD_URL', 'Failed to get upload URL')
        }

        // Step 2: Upload the file
        const fileName = apkPath.split('/').pop() || 'app.apk'
        const form = new FormData()
        form.append('authCode', urlRes.data.authCode)
        form.append('fileCount', '1')
        form.append('parseType', '0')
        form.append('file', createReadStream(apkPath))

        const uploadRes = await axios.post<{ result: { UploadFileRsp: { fileInfoList: { fileDestUlr: string }[] } } }>(
          urlRes.data.uploadUrl,
          form,
          { headers: { ...form.getHeaders() }, timeout: UPLOAD_TIMEOUT_MS, maxBodyLength: Infinity, maxContentLength: Infinity }
        ).catch((err) => stageError(`上传华为APK文件(${fileName})`, err))
        const fileUrl = uploadRes.data?.result?.UploadFileRsp?.fileInfoList?.[0]?.fileDestUlr
        if (!fileUrl) {
          throw new PlatformApiError('huawei', 'UPLOAD_FAILED', 'File upload failed')
        }

        // Step 3: Update app info with new APK
        const updateRes = await axios.put<{ ret: { code: number; msg: string } }>(
          `${base}/app-file-info`,
          {
            fileType: 5, // APK
            files: [{ fileName, fileDestUrl: fileUrl }]
          },
          { params: { appId: creds.appId }, headers: { ...headers, 'Content-Type': 'application/json' }, timeout: META_TIMEOUT_MS }
        ).catch((err) => stageError('更新华为应用文件信息', err))
        if (updateRes.data?.ret?.code !== 0) {
          throw new PlatformApiError('huawei', updateRes.data.ret.code, updateRes.data.ret.msg)
        }

        // Step 3.5: Update release notes (newFeatures) if provided
        // 缺少版本更新说明会导致提交审核时返回 204144641 "Incomplete application version information"
        if (meta.releaseNotes?.trim()) {
          await axios.put<{ ret: { code: number; msg: string } }>(
            `${base}/app-language-info`,
            { lang: 'zh-CN', newFeatures: meta.releaseNotes.trim() },
            { params: { appId: creds.appId }, headers: { ...headers, 'Content-Type': 'application/json' }, timeout: META_TIMEOUT_MS }
          ).catch((err) => stageError('更新华为版本更新说明', err))
        }

        // Step 4: Submit for review
        // 上传后华为后台需要编译 APK（约 3-5 分钟），编译期间提交会返回 PACKAGE_COMPILING_CODE，需等待后重试
        for (let submitAttempt = 0; ; submitAttempt++) {
          const submitRes = await axios.post<{ ret: { code: number; msg: string } }>(
            `${base}/app-submit`,
            {},
            { params: { appId: creds.appId }, headers: { ...headers, 'Content-Type': 'application/json' }, timeout: SUBMIT_TIMEOUT_MS }
          ).catch((err) => stageError('提交华为审核', err))
          const ret = submitRes.data?.ret
          if (ret?.code === 0) break
          if (ret?.code === PACKAGE_COMPILING_CODE && submitAttempt < SUBMIT_MAX_RETRIES) {
            // 华为后台正在编译安装包，等待后重试提交（不重新上传文件）
            await new Promise((r) => setTimeout(r, SUBMIT_RETRY_DELAY_MS))
            continue
          }
          throw new PlatformApiError('huawei', ret.code, ret.msg)
        }

        // Return appId as the "audit task ID" for Huawei
        return creds.appId
      } catch (err) {
        lastErr = err
        if (is404Error(err)) continue
        throw err
      }
    }

    throw new PlatformApiError(
      'huawei',
      'ENDPOINT_NOT_FOUND',
      `华为发布接口返回404，请核对API版本路径与应用权限。已尝试: ${AGC_BASE_CANDIDATES.join(', ')}`
    )
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const headers = await getHeaders(creds.clientId, creds.clientSecret)
    let lastErr: unknown

    for (const base of AGC_BASE_CANDIDATES) {
      try {
        const res = await axios.get<{
          ret: { code: number; msg: string }
          appInfo: { releaseState: number }
        }>(`${base}/app-info`, {
          params: { appId: auditTaskId },
          headers,
          timeout: META_TIMEOUT_MS
        }).catch((err) => stageError('查询华为审核状态', err))

        if (res.data?.ret?.code !== 0) {
          throw new PlatformApiError('huawei', res.data.ret.code, res.data.ret.msg)
        }

        // releaseState: 1=Draft,2=Published,3=Rejected,4=In-review,5=Released(pending publish)
        const state = res.data?.appInfo?.releaseState
        if (state === 4) return 'pending'
        if (state === 3) return 'failed'
        if (state === 5 || state === 2) return 'passed'
        return 'pending'
      } catch (err) {
        lastErr = err
        if (is404Error(err)) continue
        throw err
      }
    }

    if (lastErr) throw lastErr
    throw new PlatformApiError('huawei', 'ENDPOINT_NOT_FOUND', '查询审核状态接口不可用')
  }

  async publish(auditTaskId: string, creds: Record<string, string>): Promise<void> {
    const headers = await getHeaders(creds.clientId, creds.clientSecret)
    let lastErr: unknown

    for (const base of AGC_BASE_CANDIDATES) {
      try {
        const res = await axios.post<{ ret: { code: number; msg: string } }>(
          `${base}/on-shelf`,
          {},
          { params: { appId: auditTaskId }, headers: { ...headers, 'Content-Type': 'application/json' }, timeout: META_TIMEOUT_MS }
        ).catch((err) => stageError('华为上架发布', err))
        if (res.data?.ret?.code !== 0) {
          throw new PlatformApiError('huawei', res.data.ret.code, res.data.ret.msg)
        }
        return
      } catch (err) {
        lastErr = err
        if (is404Error(err)) continue
        throw err
      }
    }

    if (lastErr) throw lastErr
    throw new PlatformApiError('huawei', 'ENDPOINT_NOT_FOUND', '上架发布接口不可用')
  }

  async verify(creds: Record<string, string>): Promise<void> {
    // Validate by obtaining an access token — throws if clientId/clientSecret are invalid
    await getAccessToken(creds.clientId, creds.clientSecret)
  }
}
