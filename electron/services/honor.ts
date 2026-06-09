import axios from 'axios'
import FormData from 'form-data'
import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import { basename } from 'path'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * 荣耀应用市场 Open API（HONOR Connect / App Market Publish API）
 * Docs: https://developer.honor.com/cn/doc/guides/101360
 *
 * Token host:   https://iam.developer.honor.com/auth/token
 * Publish host: https://appmarket-openapi-drcn.cloud.honor.com/openapi/v1/publish
 *
 * Auth: OAuth2 Client Credentials（与华为 AGC 体系类似，但域名/路径不同）
 * Flow: getToken → getAppDetail → getUploadUrl → uploadFile → bindFile → (updateDesc) → submitAudit
 */

const HONOR_TOKEN_URL = 'https://iam.developer.honor.com/auth/token'
const HONOR_BASE = 'https://appmarket-openapi-drcn.cloud.honor.com'
// 荣耀 get-file-upload-url / update-file-info 中 APK 二进制的文件类型标识
const FILE_TYPE_APK = 100

const TOKEN_TIMEOUT_MS = 10_000
const META_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000
const SUBMIT_TIMEOUT_MS = 60_000

interface HonorToken {
  access_token: string
  expires_in: number
  _fetchedAt: number
}

/** 荣耀统一响应信封，code === 0 表示成功 */
interface HonorEnvelope {
  code?: number
  msg?: string
  message?: string
}

interface HonorLanguageInfo {
  languageId: string
  appName: string
  intro: string
  briefIntro?: string
}

const tokenCache = new Map<string, HonorToken>()

function envelopeText(data: HonorEnvelope | undefined): string {
  return data?.msg || data?.message || 'Unknown error'
}

function checkEnvelope(data: HonorEnvelope | undefined, context: string): void {
  if (!data || data.code !== 0) {
    throw new PlatformApiError('honor', data?.code ?? 'UNKNOWN', `${context}: ${envelopeText(data)}`)
  }
}

async function fetchToken(clientId: string, clientSecret: string): Promise<HonorToken> {
  const res = await axios.post<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
    HONOR_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TOKEN_TIMEOUT_MS }
  )
  if (res.data?.error || !res.data?.access_token) {
    const msg = res.data?.error_description || res.data?.error || 'Failed to obtain access token'
    throw new PlatformApiError('honor', res.data?.error ?? 'AUTH_FAILED', msg)
  }
  return { access_token: res.data.access_token, expires_in: res.data.expires_in ?? 3000, _fetchedAt: Date.now() }
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId)
  if (cached && Date.now() - cached._fetchedAt < (cached.expires_in - 60) * 1000) {
    return cached.access_token
  }
  tokenCache.delete(clientId)

  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1500))
    try {
      const token = await fetchToken(clientId, clientSecret)
      tokenCache.set(clientId, token)
      return token.access_token
    } catch (err) {
      lastErr = err
      if (axios.isAxiosError(err) && err.response && err.response.status < 500) break
    }
  }
  throw lastErr
}

/** 计算 APK 的字节大小与 sha256（get-file-upload-url 需要两者） */
function statAndSha256(apkPath: string): Promise<{ size: number; sha256: string }> {
  const size = statSync(apkPath).size
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(apkPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve({ size, sha256: hash.digest('hex') }))
  })
}

export class HonorService implements PlatformService {
  readonly platform = 'honor'
  readonly displayName = '荣耀应用市场'

  getCredentialSchema(): CredentialField[] {
    return [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: '荣耀开放平台 Client ID' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: '荣耀开放平台 Client Secret' },
      { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: '荣耀应用 ID' }
    ]
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)
    const appId = creds.appId
    const jsonHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    // 更新版本描述需要原样回传应用语言信息
    const lang = await this.getAppLanguage(appId, token)

    // 计算文件大小与 sha256
    const { size, sha256 } = await statAndSha256(apkPath)
    const fileName = basename(apkPath)

    // 1. 申请上传地址
    // 注意：objectId 是 int64（雪花 ID，约 19 位），超出 JS Number 安全整数范围，
    // 经 JSON.parse 会丢失精度，导致后续绑定时 "objectId is not exists"。
    // 因此保留原始响应文本，用正则提取 objectId 原始数字串，绑定时按原值回传。
    const urlRes = await axios.post<string>(
      `${HONOR_BASE}/openapi/v1/publish/get-file-upload-url`,
      [{ fileName, fileType: FILE_TYPE_APK, fileSize: size, fileSha256: sha256 }],
      { params: { appId }, headers: jsonHeaders, timeout: META_TIMEOUT_MS, transformResponse: (d) => d }
    )
    const urlRaw = typeof urlRes.data === 'string' ? urlRes.data : JSON.stringify(urlRes.data)
    const urlData = JSON.parse(urlRaw) as HonorEnvelope & { data?: { uploadUrl: string }[] }
    checkEnvelope(urlData, '获取上传地址失败')
    const uploadUrl = urlData?.data?.[0]?.uploadUrl
    const objectIdRaw = urlRaw.match(/"objectId"\s*:\s*"?(\d+)"?/)?.[1]
    if (!uploadUrl || !objectIdRaw) {
      throw new PlatformApiError('honor', 'NO_UPLOAD_URL', '未返回上传地址或 objectId')
    }

    // 2. 上传 APK 到签名地址
    const form = new FormData()
    form.append('file', createReadStream(apkPath), {
      filename: fileName,
      contentType: 'application/vnd.android.package-archive'
    })
    const uploadRes = await axios.post<HonorEnvelope>(uploadUrl, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: UPLOAD_TIMEOUT_MS
    })
    checkEnvelope(uploadRes.data, '上传 APK 失败')

    // 3. 绑定已上传的 APK
    // objectId 按 int64 原值（不加引号）回传，避免 JS Number 精度丢失，因此手动拼接 JSON 体。
    const bindRes = await axios.post<HonorEnvelope>(
      `${HONOR_BASE}/openapi/v1/publish/update-file-info`,
      `{"bindingFileList":[{"objectId":${objectIdRaw}}]}`,
      { params: { appId }, headers: jsonHeaders, timeout: META_TIMEOUT_MS, transformRequest: (d) => d }
    )
    checkEnvelope(bindRes.data, '绑定 APK 文件失败')

    // 4. 更新版本描述（更新说明）
    if (meta.releaseNotes) {
      await this.updateLanguageInfo(appId, token, lang, meta.releaseNotes)
    }

    // 5. 提交审核（releaseType=1 表示审核通过后全网自动发布）
    const submitRes = await axios.post<HonorEnvelope>(
      `${HONOR_BASE}/openapi/v1/publish/submit-audit`,
      { releaseType: 1 },
      { params: { appId }, headers: jsonHeaders, timeout: SUBMIT_TIMEOUT_MS }
    )
    checkEnvelope(submitRes.data, '提交审核失败')

    return appId
  }

  /** 获取应用语言信息（appName/intro/briefIntro），更新版本描述时需原样回传，否则会被置空 */
  private async getAppLanguage(appId: string, token: string): Promise<HonorLanguageInfo> {
    const res = await axios.get<HonorEnvelope & { data?: { languageInfo?: HonorLanguageInfo[] } }>(
      `${HONOR_BASE}/openapi/v1/publish/get-app-detail`,
      { params: { appId }, headers: { Authorization: `Bearer ${token}` }, timeout: META_TIMEOUT_MS }
    )
    checkEnvelope(res.data, '获取应用信息失败')
    const list = res.data?.data?.languageInfo ?? []
    if (list.length === 0) {
      throw new PlatformApiError('honor', 'NO_LANGUAGE_INFO', '应用详情中缺少 languageInfo')
    }
    return list.find((l) => l.languageId === 'zh-CN') ?? list[0]
  }

  private async updateLanguageInfo(
    appId: string,
    token: string,
    existing: HonorLanguageInfo,
    releaseNotes: string
  ): Promise<void> {
    // update-language-info 会把收到的空字段一并置空，因此 appName/intro/briefIntro 需原样回传，
    // 仅修改 newFeature（更新说明）。intro 为空时荣耀会返回 [20076]，需在控制台先补全应用简介。
    if (!existing.intro) {
      throw new PlatformApiError('honor', 20076, '荣耀应用简介（intro）为空，请先在荣耀开发者控制台补全后再发布')
    }
    const res = await axios.post<HonorEnvelope>(
      `${HONOR_BASE}/openapi/v1/publish/update-language-info`,
      {
        languageInfoList: [
          {
            languageId: existing.languageId,
            appName: existing.appName,
            intro: existing.intro,
            briefIntro: existing.briefIntro,
            newFeature: releaseNotes
          }
        ]
      },
      { params: { appId }, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: META_TIMEOUT_MS }
    )
    checkEnvelope(res.data, '更新版本描述失败')
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)

    const res = await axios.get<HonorEnvelope & { data?: { auditResult?: number } }>(
      `${HONOR_BASE}/openapi/v1/publish/get-app-current-release`,
      { params: { appId: auditTaskId }, headers: { Authorization: `Bearer ${token}` }, timeout: META_TIMEOUT_MS }
    )
    checkEnvelope(res.data, '查询审核状态失败')

    // auditResult: 0-审核中 1-审核通过 2-审核不通过 3-其他非审核状态 4-编辑中未提交
    switch (res.data?.data?.auditResult) {
      case 1:
        return 'passed'
      case 2:
        return 'failed'
      default:
        return 'pending'
    }
  }

  async publish(_auditTaskId: string, _creds: Record<string, string>): Promise<void> {
    // 荣耀提交审核时 releaseType=1 已设置为审核通过后全网自动发布，无需单独触发上架。
  }

  async verify(creds: Record<string, string>): Promise<void> {
    await getAccessToken(creds.clientId, creds.clientSecret)
  }
}
