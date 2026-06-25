import axios from 'axios'
import FormData from 'form-data'
import { createReadStream } from 'fs'
import * as crypto from 'crypto'
import type { PlatformService, CredentialField, UploadMeta, AuditStatus } from './base'
import { PlatformApiError } from './base'

/**
 * OPPO 开放平台 Open API
 * Docs: https://open.oppomobile.com/new/developmentDoc/info?id=10998
 *
 * Auth: GET /developer/v1/token?client_id&client_secret → access_token（无需签名）
 * 资源接口（/resource/v1/...）需对参数签名：
 *   追加 access_token + timestamp(秒) → 参数名 ASCII 升序拼成 k=v&k=v
 *   → HMAC-SHA256(clientSecret) hex → api_sign
 *
 * 发布流程: queryApp(获取应用元数据) → uploadAPK → app/upd(提交版本) → app/task-state(轮询)
 */

const OPPO_DOMAIN = 'https://oop-openapi-cn.heytapmobi.com'
const TOKEN_TIMEOUT_MS = 15_000
const META_TIMEOUT_MS = 30_000
const UPLOAD_TIMEOUT_MS = 15 * 60_000

// 发布时的非失败错误码
const OPPO_TASK_IN_FLIGHT = 911216 // 版本更新任务处理中
const OPPO_UNDER_REVIEW = 911215 // 应用审核中（已进入审核队列）

interface OppoToken {
  access_token: string
  expire_time: number // Unix timestamp ms
}

interface OppoAppData {
  app_name?: string
  second_category_id?: string
  third_category_id?: string
  summary?: string
  detail_desc?: string
  privacy_source_url?: string
  icon_url?: string
  pic_url?: string
  copyright_url?: string
  business_username?: string
  business_email?: string
  business_mobile?: string
  age_level?: string
  adaptive_equipment?: string
  customer_contact?: string
}

const tokenCache = new Map<string, OppoToken>()

function sanitizeOppoImageUrl(raw: string | undefined, strict = true): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  // 宽松模式：queryApp 返回的 OPPO CDN 链接直接原样透传
  if (!strict) {
    if (/^https?:\/\//i.test(value)) return value
    return '' // 非 HTTP URL 丢弃
  }
  // 严格模式：用户提供的 URL，清洗 query/hash，拦截非法格式
  try {
    const u = new URL(value)
    u.search = ''
    u.hash = ''
    if (/\.(webp|gif|bmp|svg)$/i.test(u.pathname)) return ''
    return u.toString()
  } catch {
    return ''
  }
}

/** 从 OPPO 响应中提取可读错误信息（消息位置不固定） */
function parseOppoError(data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    const candidates = [
      d.message,
      d.msg,
      (d.data as Record<string, unknown> | undefined)?.message,
      (d.data as Record<string, unknown> | undefined)?.msg
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c
    }
  }
  return 'Unknown OPPO API error'
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId)
  if (cached && Date.now() < cached.expire_time - 60_000) {
    return cached.access_token
  }

  const res = await axios.get<{
    errno: number
    data?: { access_token?: string; expire_in?: number }
  }>(`${OPPO_DOMAIN}/developer/v1/token`, {
    params: { client_id: clientId, client_secret: clientSecret },
    timeout: TOKEN_TIMEOUT_MS
  })

  if (res.data?.errno !== 0 || !res.data.data?.access_token) {
    throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
  }

  const expireInSec = res.data.data.expire_in ?? 23 * 3600
  const token: OppoToken = {
    access_token: res.data.data.access_token,
    expire_time: Date.now() + expireInSec * 1000
  }
  tokenCache.set(clientId, token)
  return token.access_token
}

/** 追加公共参数并计算 api_sign 签名 */
function signParams(
  params: Record<string, string>,
  accessToken: string,
  clientSecret: string
): Record<string, string> {
  const signed: Record<string, string> = {
    ...params,
    access_token: accessToken,
    timestamp: Math.floor(Date.now() / 1000).toString()
  }
  const signStr = Object.keys(signed)
    .sort()
    .map((k) => `${k}=${signed[k]}`)
    .join('&')
  signed.api_sign = crypto.createHmac('sha256', clientSecret).update(signStr).digest('hex')
  return signed
}

export class OppoService implements PlatformService {
  readonly platform = 'oppo'
  readonly displayName = 'OPPO 应用商店'

  getCredentialSchema(): CredentialField[] {
    return [
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        placeholder: 'OPPO 开放平台 Client ID'
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        placeholder: 'OPPO 开放平台 Client Secret'
      },
      {
        key: 'packageName',
        label: '包名 (Package Name)',
        type: 'text',
        required: true,
        placeholder: 'com.example.app'
      },
      {
        key: 'iconUrl',
        label: '图标 URL (可选，覆盖后台图标)',
        type: 'text',
        required: false,
        placeholder: '512x512 PNG 直链，不填则用 queryApp 返回值'
      },
      {
        key: 'picUrl',
        label: '截图 URL (可选，覆盖后台截图)',
        type: 'text',
        required: false,
        placeholder: '竖版截图直链，逗号分隔，不填则用 queryApp 返回值'
      }
    ]
  }

  /** 查询应用已有元数据（提交版本时复用，避免缺字段被拒） */
  private async queryApp(
    pkgName: string,
    token: string,
    clientSecret: string
  ): Promise<OppoAppData> {
    const res = await axios.get<{ errno: number; data?: OppoAppData }>(
      `${OPPO_DOMAIN}/resource/v1/app/info`,
      {
        params: signParams({ pkg_name: pkgName }, token, clientSecret),
        timeout: META_TIMEOUT_MS
      }
    )
    if (res.data?.errno !== 0 || !res.data.data) {
      throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
    }
    return res.data.data
  }

  /** 上传 APK 文件，返回 { url, md5 } */
  private async uploadApk(
    apkPath: string,
    token: string,
    clientSecret: string
  ): Promise<{ url: string; md5: string }> {
    // Step 1: 获取上传地址
    const urlRes = await axios.get<{
      errno: number
      data?: { upload_url?: string; sign?: string }
    }>(`${OPPO_DOMAIN}/resource/v1/upload/get-upload-url`, {
      params: signParams({}, token, clientSecret),
      timeout: META_TIMEOUT_MS
    })
    if (urlRes.data?.errno !== 0 || !urlRes.data.data?.upload_url || !urlRes.data.data.sign) {
      throw new PlatformApiError('oppo', urlRes.data?.errno, parseOppoError(urlRes.data))
    }

    // Step 2: 上传文件
    const form = new FormData()
    form.append('sign', urlRes.data.data.sign)
    form.append('type', 'apk')
    form.append('file', createReadStream(apkPath))

    const uploadRes = await axios.post<{
      errno: number
      data?: { url?: string; md5?: string }
    }>(urlRes.data.data.upload_url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    if (uploadRes.data?.errno !== 0 || !uploadRes.data.data?.url) {
      throw new PlatformApiError('oppo', uploadRes.data?.errno, parseOppoError(uploadRes.data))
    }
    return { url: uploadRes.data.data.url, md5: uploadRes.data.data.md5 ?? '' }
  }

  /** 上传图片文件到 OPPO CDN，返回正规 URL */
  private async uploadPhoto(
    imageUrl: string,
    token: string,
    clientSecret: string
  ): Promise<string> {
    // 下载原图
    const dl = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000
    })
    const buf = Buffer.from(dl.data)

    // 获取上传地址
    const urlRes = await axios.get<{
      errno: number
      data?: { upload_url?: string; sign?: string }
    }>(`${OPPO_DOMAIN}/resource/v1/upload/get-upload-url`, {
      params: signParams({}, token, clientSecret),
      timeout: META_TIMEOUT_MS
    })
    if (urlRes.data?.errno !== 0 || !urlRes.data.data?.upload_url || !urlRes.data.data.sign) {
      throw new PlatformApiError('oppo', urlRes.data?.errno, parseOppoError(urlRes.data))
    }

    // 上传
    const form = new FormData()
    form.append('sign', urlRes.data.data.sign)
    form.append('type', 'photo')
    form.append('file', buf, { filename: 'icon.png' })

    const uploadRes = await axios.post<{
      errno: number
      data?: { url?: string; md5?: string }
    }>(urlRes.data.data.upload_url, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })
    if (uploadRes.data?.errno !== 0 || !uploadRes.data.data?.url) {
      throw new PlatformApiError('oppo', uploadRes.data?.errno, parseOppoError(uploadRes.data))
    }
    return uploadRes.data.data.url
  }

  async upload(apkPath: string, meta: UploadMeta, creds: Record<string, string>): Promise<string> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)
    const pkgName = creds.packageName
    const releaseNotes = (meta.releaseNotes ?? '').trim()
    const safeTestDesc = releaseNotes || '常规功能验证通过'

    // Step 1: 查询应用已有元数据
    const app = await this.queryApp(pkgName, token, creds.clientSecret)

    // Step 2: 上传 APK
    const apk = await this.uploadApk(apkPath, token, creds.clientSecret)
    const apkUrl = JSON.stringify([{ url: apk.url, md5: apk.md5, cpu_code: 0 }])

    // icon_url: 优先用户提供 → 否则从 queryApp 下载后重新上传到 OPPO CDN
    const manualIconUrl = sanitizeOppoImageUrl(creds.iconUrl)
    let safeIconUrl = manualIconUrl
    if (!safeIconUrl && app.icon_url) {
      try {
        console.log('[oppo] re-uploading icon from queryApp URL:', app.icon_url)
        safeIconUrl = await this.uploadPhoto(app.icon_url, token, creds.clientSecret)
        console.log('[oppo] re-uploaded icon URL:', safeIconUrl)
      } catch (e) {
        console.log('[oppo] icon re-upload failed, trying raw queryApp URL:', (e as Error).message)
        safeIconUrl = sanitizeOppoImageUrl(app.icon_url, false)
      }
    }

    // pic_url: 优先用户提供 → 否则从 queryApp 下载后逐张重传到 OPPO CDN
    const manualPicUrl = sanitizeOppoImageUrl(creds.picUrl)
    let safePicUrl = manualPicUrl
    if (!safePicUrl && app.pic_url) {
      try {
        const rawUrls = app.pic_url.split(',').map((u) => u.trim()).filter(Boolean)
        console.log('[oppo] re-uploading', rawUrls.length, 'screenshots from queryApp')
        const newUrls: string[] = []
        for (const rawUrl of rawUrls) {
          const url = await this.uploadPhoto(rawUrl, token, creds.clientSecret)
          newUrls.push(url)
        }
        safePicUrl = newUrls.join(',')
        console.log('[oppo] re-uploaded pic_urls:', safePicUrl)
      } catch (e) {
        console.log('[oppo] pic re-upload failed, trying raw queryApp URL:', (e as Error).message)
        safePicUrl = sanitizeOppoImageUrl(app.pic_url, false)
      }
    }
    console.log('[oppo] final icon_url:', safeIconUrl || '(empty)')
    console.log('[oppo] final pic_url:', safePicUrl || '(empty)')

    // Step 3: 提交版本（online_type=1 表示审核通过后立即发布）
    const values: Record<string, string> = {
      pkg_name: pkgName,
      version_code: String(meta.versionCode),
      apk_url: apkUrl,
      app_name: app.app_name ?? '',
      second_category_id: app.second_category_id ?? '',
      third_category_id: app.third_category_id ?? '',
      // OPPO 限制 summary（一句话简介）最多 13 个字符，回传旧值时需截断避免被拒
      summary: (app.summary ?? '').slice(0, 13),
      detail_desc: app.detail_desc ?? '',
      update_desc: releaseNotes,
      privacy_source_url: app.privacy_source_url ?? '',
      online_type: '1',
      test_desc: safeTestDesc,
      copyright_url: app.copyright_url ?? '',
      business_username: app.business_username ?? '',
      business_email: app.business_email ?? '',
      business_mobile: app.business_mobile ?? '',
      age_level: app.age_level ?? '',
      adaptive_equipment: app.adaptive_equipment ?? '',
      adaptive_type: '2',
      customer_contact: app.customer_contact ?? ''
    }
    // 仅在有值时传 icon_url/pic_url，不传则 OPPO 保留后台已有数据
    if (safeIconUrl) {
      values.icon_url = safeIconUrl
    }
    if (safePicUrl) {
      values.pic_url = safePicUrl
    }

    const res = await axios.post<{ errno: number }>(
      `${OPPO_DOMAIN}/resource/v1/app/upd`,
      new URLSearchParams(signParams(values, token, creds.clientSecret)).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: META_TIMEOUT_MS
      }
    )
    const errno = res.data?.errno
    // 911215/911216 不是真正的失败：版本已在审核队列或上一个任务处理中
    if (errno !== 0 && errno !== OPPO_UNDER_REVIEW && errno !== OPPO_TASK_IN_FLIGHT) {
      throw new PlatformApiError('oppo', errno, parseOppoError(res.data))
    }

    // 返回 version_code 作为审核任务 ID（轮询时配合 creds.packageName 使用）
    return String(meta.versionCode)
  }

  async getAuditStatus(auditTaskId: string, creds: Record<string, string>): Promise<AuditStatus> {
    const token = await getAccessToken(creds.clientId, creds.clientSecret)

    const res = await axios.post<{
      errno: number
      data?: { task_state?: string; err_msg?: string }
    }>(
      `${OPPO_DOMAIN}/resource/v1/app/task-state`,
      new URLSearchParams(
        signParams(
          { pkg_name: creds.packageName, version_code: auditTaskId },
          token,
          creds.clientSecret
        )
      ).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: META_TIMEOUT_MS
      }
    )

    if (res.data?.errno !== 0) {
      throw new PlatformApiError('oppo', res.data?.errno, parseOppoError(res.data))
    }

    // task_state: 2=成功, 3=失败, 其它=处理中
    const state = res.data.data?.task_state
    if (state === '2') return 'passed'
    if (state === '3') return 'failed'
    return 'pending'
  }

  async publish(): Promise<void> {
    // OPPO 提交时已使用 online_type=1（审核通过后自动发布），无需单独的上架接口
  }

  async verify(creds: Record<string, string>): Promise<void> {
    await getAccessToken(creds.clientId, creds.clientSecret)
  }
}
